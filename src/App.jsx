import React, { useRef, useState, useEffect, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Stars, RoundedBox, MeshDistortMaterial } from '@react-three/drei';
import * as THREE from 'three';
import countryColorsData from './countriesColors.json';

// Easing "back out" : dépasse légèrement 1 puis revient, donne un effet de
// "pop"/rebond naturel quand le personnage prend forme (utile pour l'arrivée
// sur la terre ferme après la chaloupe).
function easeOutBack(x) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

// 1. Mathématiques : Projette la géométrie et les collisions
function projectGeometryToSphere(geometry, baseRadius = 5) {
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const lon = pos.getX(i);
    const lat = pos.getY(i);
    const depth = pos.getZ(i);

    const r = baseRadius + depth;
    const phi = (90 - lat) * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);

    const x = -(r * Math.sin(phi) * Math.cos(theta));
    const z = (r * Math.sin(phi) * Math.sin(theta));
    const y = (r * Math.cos(phi));

    pos.setXYZ(i, x, y, z);
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

function pointInPolygon(point, vs) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const [xi, yi] = vs[i];
    const [xj, yj] = vs[j];
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function getCountryAtPosition(lat, lon, countriesData) {
  if (!countriesData || countriesData.length === 0) return null;
  
  for (let feature of countriesData) {
    const type = feature.geometry.type;
    const coordinates = type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;

    for (let polygonCoords of coordinates) {
      const outerRing = polygonCoords[0];
      if (pointInPolygon([lon, lat], outerRing)) {
        return feature.properties.name || 'Pays inconnu';
      }
    }
  }
  return null;
}

// 2. Chaloupe et personnage assis
// Silhouette de coque en "canoë" : pointue à l'avant/arrière, évasée au centre.
// Générée une seule fois (hors composant) pour ne pas recréer la géométrie à chaque frame.
const CANOE_HULL_GEOMETRY = (() => {
  const shape = new THREE.Shape();
  const halfLength = 0.21;
  const points = [
    [0, -halfLength],
    [0.05, -halfLength * 0.7],
    [0.09, -halfLength * 0.15],
    [0.1, 0],
    [0.09, halfLength * 0.15],
    [0.05, halfLength * 0.7],
    [0, halfLength],
    [-0.05, halfLength * 0.7],
    [-0.09, halfLength * 0.15],
    [-0.1, 0],
    [-0.09, -halfLength * 0.15],
    [-0.05, -halfLength * 0.7],
  ];
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: 0.1,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.015,
    bevelSegments: 3,
    curveSegments: 8,
  });
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, -0.05, 0);
  return geom;
})();

const Oar = ({ side }) => (
  <group position={[side * 0.16, 0, 0]} rotation={[0, 0, side * Math.PI / 4]}>
    <mesh castShadow>
      <capsuleGeometry args={[0.007, 0.19, 4, 6]} />
      <meshStandardMaterial color="#6B4423" roughness={0.8} />
    </mesh>
    <mesh position={[0, 0.12, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
      <boxGeometry args={[0.015, 0.06, 0.03]} />
      <meshStandardMaterial color="#5C4033" roughness={0.8} />
    </mesh>
  </group>
);

const BoatWithRider = ({ oarRef, transitionProgress }) => {
  const skinColor = "#FFC3A0";
  const shirtColor = "#FF5733";
  const pantsColor = "#1E40AF";

  const riderY = 0.09 + (1 - transitionProgress) * 0.2;
  const riderScale = Math.max(0.1, transitionProgress);

  return (
    <group position={[0, 0.05, 0]}>
      {/* Coque de la chaloupe (silhouette canoë, plus organique qu'un simple pavé) */}
      <mesh geometry={CANOE_HULL_GEOMETRY} castShadow receiveShadow>
        <meshStandardMaterial color="#8B4513" roughness={0.75} flatShading={true} />
      </mesh>
      {/* Liseré intérieur (donne une impression de coque creuse) */}
      <mesh position={[0, 0.055, 0]} scale={[0.82, 1, 0.82]}>
        <cylinderGeometry args={[0.09, 0.09, 0.02, 12]} />
        <meshStandardMaterial color="#6B4423" roughness={0.9} />
      </mesh>
      {/* Banc du bateau */}
      <RoundedBox args={[0.19, 0.018, 0.07]} radius={0.006} smoothness={2} position={[0, 0.08, 0]} castShadow>
        <meshStandardMaterial color="#A0522D" roughness={0.7} />
      </RoundedBox>

      {/* Personnage assis dans la chaloupe */}
      <group position={[0, riderY, 0]} rotation={[0, Math.PI, 0]} scale={[1, riderScale, 1]}>
        {/* Tête */}
        <RoundedBox args={[0.095, 0.095, 0.095]} radius={0.02} smoothness={3} position={[0, 0.2, 0]} castShadow>
          <meshStandardMaterial color={skinColor} flatShading={true} />
        </RoundedBox>
        {/* Petite touffe de cheveux (cohérente avec le personnage à pied) */}
        <mesh position={[0, 0.253, 0.005]} castShadow>
          <sphereGeometry args={[0.05, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
          <meshStandardMaterial color="#3B2412" flatShading={true} />
        </mesh>
        {/* Yeux — ce groupe est tourné à 180° (rotation={[0, Math.PI, 0]} ci-dessus),
            donc on les place en z positif ici pour qu'ils pointent dans la même
            direction relative que sur terre ferme (dos tourné vers la caméra). */}
        <mesh position={[-0.02, 0.2, 0.045]}>
          <sphereGeometry args={[0.008, 6, 6]} />
          <meshStandardMaterial color="#2b2b2b" />
        </mesh>
        <mesh position={[0.02, 0.2, 0.045]}>
          <sphereGeometry args={[0.008, 6, 6]} />
          <meshStandardMaterial color="#2b2b2b" />
        </mesh>
        {/* Torse */}
        <RoundedBox args={[0.12, 0.14, 0.07]} radius={0.02} smoothness={3} position={[0, 0.08, 0]} rotation={[0.2, 0, 0]} castShadow>
          <meshStandardMaterial color={shirtColor} flatShading={true} />
        </RoundedBox>
        {/* Jambes (capsules, assises pliées) */}
        <mesh position={[-0.035, -0.01, 0.05]} rotation={[Math.PI / 3, 0, 0]} castShadow>
          <capsuleGeometry args={[0.02, 0.08, 4, 6]} />
          <meshStandardMaterial color={pantsColor} flatShading={true} />
        </mesh>
        <mesh position={[0.035, -0.01, 0.05]} rotation={[Math.PI / 3, 0, 0]} castShadow>
          <capsuleGeometry args={[0.02, 0.08, 4, 6]} />
          <meshStandardMaterial color={pantsColor} flatShading={true} />
        </mesh>
      </group>

      {/* Rames */}
      <group ref={oarRef} position={[0, 0.12, 0]}>
        <Oar side={-1} />
        <Oar side={1} />
      </group>
    </group>
  );
};

// 3. Modèle du personnage (sur terre)
// Torse et tête en RoundedBox (coins adoucis) + membres en capsules pour un
// rendu low-poly plus "mignon" que des pavés bruts, tout en gardant la même
// hiérarchie de refs (legL/legR/armL/armR/bodyRef) pour ne pas casser l'animation.
const Stickman = ({ legL, legR, armL, armR, bodyRef, showFlagInHand, transitionProgress = 1, walkBob = 0, walkLean = 0 }) => {
  const skinColor = "#FFC3A0"; 
  const shirtColor = "#FF5733"; 
  const pantsColor = "#1E40AF"; 
  const hairColor = "#3B2412";

  // transitionProgress passe de 0 à 1 juste après avoir quitté la chaloupe :
  // ça sert à faire "apparaître" le personnage sur la terre ferme avec un
  // petit rebond (au lieu d'un pop instantané comme avant).
  const p = Math.min(1, Math.max(0, transitionProgress));
  const landScale = THREE.MathUtils.lerp(0.4, 1, easeOutBack(p));
  const hopOffset = Math.sin(p * Math.PI) * 0.1;

  return (
    <group ref={bodyRef} position={[0, 0.15, 0]}>
      <group
        scale={[landScale, landScale, landScale]}
        position={[0, hopOffset + walkBob, 0]}
        rotation={[walkLean, 0, 0]}
      >
      {/* Tête */}
      <RoundedBox args={[0.1, 0.1, 0.1]} radius={0.022} smoothness={3} position={[0, 0.25, 0]} castShadow>
        <meshStandardMaterial color={skinColor} flatShading={true} />
      </RoundedBox>
      {/* Petite touffe de cheveux */}
      <mesh position={[0, 0.305, -0.005]} castShadow>
        <sphereGeometry args={[0.052, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
        <meshStandardMaterial color={hairColor} flatShading={true} />
      </mesh>
      {/* Yeux — placés en z négatif : le personnage tourne le dos à la caméra
          (comme dans un jeu en 3e personne classique), face tournée dans le
          sens de la marche. Avant ce fix, ils étaient en z positif et le
          personnage donnait l'impression de "moonwalker" en avançant. */}
      <mesh position={[-0.025, 0.255, -0.05]}>
        <sphereGeometry args={[0.009, 6, 6]} />
        <meshStandardMaterial color="#2b2b2b" />
      </mesh>
      <mesh position={[0.025, 0.255, -0.05]}>
        <sphereGeometry args={[0.009, 6, 6]} />
        <meshStandardMaterial color="#2b2b2b" />
      </mesh>

      {/* Torse */}
      <RoundedBox args={[0.12, 0.15, 0.07]} radius={0.025} smoothness={3} position={[0, 0.1, 0]} castShadow>
        <meshStandardMaterial color={shirtColor} flatShading={true} />
      </RoundedBox>

      {/* Bras gauche */}
      <group ref={armL} position={[-0.08, 0.15, 0]}>
        <mesh position={[0, -0.07, 0]} castShadow>
          <capsuleGeometry args={[0.018, 0.09, 4, 6]} />
          <meshStandardMaterial color={skinColor} flatShading={true} />
        </mesh>
      </group>
      {/* Bras droit (porte le drapeau lors du plantage) */}
      <group ref={armR} position={[0.08, 0.15, 0]}>
        <mesh position={[0, -0.07, 0]} castShadow>
          <capsuleGeometry args={[0.018, 0.09, 4, 6]} />
          <meshStandardMaterial color={skinColor} flatShading={true} />
        </mesh>
        {showFlagInHand && (
          <group position={[0, -0.15, 0.05]} rotation={[-Math.PI / 4, 0, 0]}>
            <mesh position={[0, 0.1, 0]}>
              <cylinderGeometry args={[0.008, 0.008, 0.25, 6]} />
              <meshStandardMaterial color="#333333" />
            </mesh>
            <mesh position={[0.06, 0.2, 0]}>
              <boxGeometry args={[0.1, 0.07, 0.01]} />
              <meshStandardMaterial color="#EF4444" />
            </mesh>
          </group>
        )}
      </group>

      {/* Jambe gauche */}
      <group ref={legL} position={[-0.035, 0.02, 0]}>
        <mesh position={[0, -0.07, 0]} castShadow>
          <capsuleGeometry args={[0.02, 0.09, 4, 6]} />
          <meshStandardMaterial color={pantsColor} flatShading={true} />
        </mesh>
      </group>
      {/* Jambe droite */}
      <group ref={legR} position={[0.035, 0.02, 0]}>
        <mesh position={[0, -0.07, 0]} castShadow>
          <capsuleGeometry args={[0.02, 0.09, 4, 6]} />
          <meshStandardMaterial color={pantsColor} flatShading={true} />
        </mesh>
      </group>
      </group>
    </group>
  );
};

// 4. Drapeau planté (Correction définitive de l'orientation avec Quaternion universel)
const FlagMarker = ({ position, countryName, onClick }) => {
  const groupRef = useRef();
  const clothRef = useRef();
  const [hovered, setHovered] = useState(false);
  // Décale légèrement la phase du flottement selon la position pour que tous
  // les drapeaux ne battent pas exactement en même temps.
  const wavePhase = useMemo(() => (position.x + position.y + position.z) * 3.7, [position]);

  useEffect(() => {
    if (groupRef.current) {
      groupRef.current.position.copy(position);

      // Normale exacte depuis le centre de la sphère
      const normal = position.clone().normalize();
      
      // Aligne l'axe Y local (0, 1, 0) du drapeau parfaitement avec la normale de la sphère sur tous les hémisphères
      const upVector = new THREE.Vector3(0, 1, 0);
      const quaternion = new THREE.Quaternion().setFromUnitVectors(upVector, normal);
      groupRef.current.quaternion.copy(quaternion);
    }
  }, [position]);

  useFrame(({ clock }) => {
    if (clothRef.current) {
      // Léger flottement rigide (pas de vraie simulation de tissu, mais suffisant
      // visuellement et très peu coûteux) : oscillation du tissu autour du mât.
      const t = clock.getElapsedTime() * 3 + wavePhase;
      clothRef.current.rotation.y = Math.sin(t) * 0.18;
      clothRef.current.rotation.z = Math.sin(t * 1.3) * 0.05;
    }
  });

  return (
    <group ref={groupRef}>
      <mesh 
        position={[0, 0.15, 0]} 
        onPointerEnter={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
        onPointerLeave={(e) => { e.stopPropagation(); setHovered(false); document.body.style.cursor = 'default'; }}
        onClick={(e) => { e.stopPropagation(); document.body.style.cursor = 'default'; onClick(countryName); }}
      >
        <boxGeometry args={[0.3, 0.4, 0.3]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>

      <mesh position={[0, 0.15, 0]} castShadow raycast={() => null}>
        <capsuleGeometry args={[0.008, 0.28, 4, 6]} />
        <meshStandardMaterial color="#333333" roughness={0.4} />
      </mesh>

      {/* Boule au sommet du mât */}
      <mesh position={[0, 0.3, 0]} raycast={() => null}>
        <sphereGeometry args={[0.014, 8, 8]} />
        <meshStandardMaterial color="#D4AF37" roughness={0.3} metalness={0.6} />
      </mesh>

      {/* Le tissu du drapeau pivote légèrement au mât pour simuler le vent */}
      <group ref={clothRef} position={[0, 0.25, 0]}>
        <mesh position={[0.075, 0, 0]} castShadow raycast={() => null}>
          <boxGeometry args={[0.14, 0.09, 0.008]} />
          <meshStandardMaterial color="#EF4444" roughness={0.35} side={THREE.DoubleSide} />
        </mesh>
        {hovered && (
          <mesh position={[0.075, 0, -0.006]} raycast={() => null}>
            <boxGeometry args={[0.16, 0.11, 0.004]} />
            <meshBasicMaterial color="#FFFFFF" />
          </mesh>
        )}
      </group>
    </group>
  );
};

// 5. Composant Player
const Player = ({ targetPosition, controlMode, countriesData, onWaterChange, onLocationChange, onPlantFlag, visitedFlags }) => {
  const playerRef = useRef();
  const { camera } = useThree();
  
  const legL = useRef();
  const legR = useRef();
  const armL = useRef();
  const armR = useRef();
  const bodyRef = useRef();
  const oarRef = useRef();

  const playerPos = useRef(new THREE.Vector3(0, 5.12, 0));
  const playerDir = useRef(new THREE.Vector3(0, 0, 1));
  const keys = useRef({ z: false, q: false, s: false, d: false, space: false });
  const [isOnWater, setIsOnWater] = useState(false);
  const [showFlagInHand, setShowFlagInHand] = useState(false);
  const [transitionProgress, setTransitionProgress] = useState(1);
  
  const isPlacingFlag = useRef(false);
  const plantAnimTime = useRef(0);
  const currentCountryRef = useRef(null);
  const prevWaterState = useRef(false);
  const transitionStartTime = useRef(-10);
  // Anti-flapping : près des archipels (nord du Canada, Indonésie...), la
  // position peut traverser terre/eau plusieurs fois par seconde. On retarde
  // l'état "acté" jusqu'à ce que le nouvel état tienne un court instant.
  const pendingWaterState = useRef(null);
  const pendingSince = useRef(0);
  const WATER_STATE_DEBOUNCE = 0.12; // secondes
  const walkAnim = useRef({ bob: 0, lean: 0 });

  // Pool de particules réutilisées pour l'éclaboussure terre/eau (évite de
  // créer/détruire des meshes en continu, donc quasi gratuit en perf).
  const SPLASH_COUNT = 14;
  const splashMeshes = useRef([]);
  const splashData = useRef(
    Array.from({ length: SPLASH_COUNT }, () => ({
      life: 999,
      maxLife: 1,
      vel: new THREE.Vector3(),
      pos: new THREE.Vector3(),
    }))
  );

  const spawnSplash = (origin, normal) => {
    // Deux vecteurs tangents au plan perpendiculaire à la normale du globe à
    // cet endroit, pour disperser les particules "à plat" sur la surface de l'eau.
    let helper = new THREE.Vector3(0, 1, 0);
    if (Math.abs(normal.dot(helper)) > 0.9) helper = new THREE.Vector3(1, 0, 0);
    const t1 = new THREE.Vector3().crossVectors(normal, helper).normalize();
    const t2 = new THREE.Vector3().crossVectors(normal, t1).normalize();

    splashData.current.forEach((p) => {
      const angle = Math.random() * Math.PI * 2;
      const outward = 0.02 + Math.random() * 0.035;
      const up = 0.03 + Math.random() * 0.035;
      p.vel
        .copy(t1).multiplyScalar(Math.cos(angle) * outward)
        .addScaledVector(t2, Math.sin(angle) * outward)
        .addScaledVector(normal, up);
      p.pos.copy(origin);
      p.life = 0;
      p.maxLife = 0.35 + Math.random() * 0.25;
    });
  };

  useEffect(() => {
    if (controlMode !== 'zqsd') return;

    const handleKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === 'z') keys.current.z = true;
      if (k === 'q') keys.current.q = true;
      if (k === 's') keys.current.s = true;
      if (k === 'd') keys.current.d = true;
      if (e.code === 'Space') keys.current.space = true;
    };

    const handleKeyUp = (e) => {
      const k = e.key.toLowerCase();
      if (k === 'z') keys.current.z = false;
      if (k === 'q') keys.current.q = false;
      if (k === 's') keys.current.s = false;
      if (k === 'd') keys.current.d = false;
      if (e.code === 'Space') keys.current.space = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [controlMode]);

  useFrame(({ clock }, delta) => {
    if (!playerRef.current) return;

    let isMoving = false;
    const radius = 5.12;

    if (controlMode === 'zqsd') {
      const moveSpeed = 0.025;
      const rotateSpeed = 0.02;

      const hasFlagHere = currentCountryRef.current && visitedFlags.some(f => f.country === currentCountryRef.current);

      if (keys.current.space && !isPlacingFlag.current && !isOnWater && currentCountryRef.current && !hasFlagHere) {
        isPlacingFlag.current = true;
        plantAnimTime.current = clock.getElapsedTime();
        setShowFlagInHand(true);
      }

      if (isPlacingFlag.current) {
        const elapsed = clock.getElapsedTime() - plantAnimTime.current;
        if (bodyRef.current) {
          bodyRef.current.rotation.x = Math.sin(elapsed * 6) * 0.4;
        }
        if (armR.current) {
          armR.current.rotation.x = -Math.sin(elapsed * 6) * 1.2;
        }
        
        if (elapsed > 0.5 && showFlagInHand) {
          setShowFlagInHand(false);
          if (onPlantFlag) onPlantFlag(playerPos.current.clone());
        }

        if (elapsed > 1.0) {
          isPlacingFlag.current = false;
          if (bodyRef.current) bodyRef.current.rotation.x = 0;
          if (armR.current) armR.current.rotation.x = 0;
        }
      } else {
        if (keys.current.q) {
          const axis = playerPos.current.clone().normalize();
          playerDir.current.applyAxisAngle(axis, rotateSpeed);
          isMoving = true;
        }
        if (keys.current.d) {
          const axis = playerPos.current.clone().normalize();
          playerDir.current.applyAxisAngle(axis, -rotateSpeed);
          isMoving = true;
        }

        let step = 0;
        if (keys.current.z) { step = moveSpeed; isMoving = true; }
        if (keys.current.s) { step = -moveSpeed; isMoving = true; }

        if (step !== 0) {
          const moveVector = playerDir.current.clone().normalize().multiplyScalar(step);
          playerPos.current.add(moveVector);
          playerPos.current.normalize().multiplyScalar(radius);
        }
      }

      playerRef.current.position.copy(playerPos.current);

      const upNormal = playerPos.current.clone().normalize();
      playerDir.current.sub(upNormal.clone().multiplyScalar(playerDir.current.dot(upNormal))).normalize();
      const targetLook = playerPos.current.clone().add(playerDir.current);
      
      const matrix = new THREE.Matrix4();
      matrix.lookAt(playerPos.current, targetLook, upNormal);
      playerRef.current.quaternion.setFromRotationMatrix(matrix);

      const lat = 90 - (Math.acos(Math.max(-1, Math.min(1, playerPos.current.y / radius))) * 180 / Math.PI);
      const theta = Math.atan2(playerPos.current.z, -playerPos.current.x);
      let lon = (theta * 180 / Math.PI) - 180;
      if (lon < -180) lon += 360;

      const currentCountry = getCountryAtPosition(lat, lon, countriesData);
      currentCountryRef.current = currentCountry;
      const rawWaterState = !currentCountry;
      const now = clock.getElapsedTime();

      if (rawWaterState !== prevWaterState.current) {
        // On vient (peut-être) de changer d'état : on ne l'acte pas tout de
        // suite, on note juste depuis quand ce nouvel état est "candidat".
        if (pendingWaterState.current !== rawWaterState) {
          pendingWaterState.current = rawWaterState;
          pendingSince.current = now;
        } else if (now - pendingSince.current > WATER_STATE_DEBOUNCE) {
          // Le nouvel état a tenu assez longtemps : on l'acte pour de bon.
          prevWaterState.current = rawWaterState;
          transitionStartTime.current = now;
          spawnSplash(playerPos.current, upNormal);
          pendingWaterState.current = null;
        }
      } else {
        // On est revenu à l'état déjà acté avant la fin du délai : on annule
        // le changement en attente (évite le clignotement bateau/pas bateau).
        pendingWaterState.current = null;
      }

      const waterState = prevWaterState.current;

      const tTrans = now - transitionStartTime.current;
      const progress = Math.min(1, tTrans / 0.6);
      setTransitionProgress(progress);

      setIsOnWater(waterState);
      if (onWaterChange) onWaterChange(waterState);
      if (onLocationChange) onLocationChange(currentCountry);

      const backwardDir = playerDir.current.clone().negate();
      const idealCameraPos = playerPos.current.clone()
        .add(backwardDir.multiplyScalar(2.8))
        .add(upNormal.multiplyScalar(5.0));

      camera.position.lerp(idealCameraPos, 0.15);
      camera.up.copy(upNormal);
      const camLookMatrix = new THREE.Matrix4().lookAt(camera.position, playerPos.current, upNormal);
      const camTargetQuat = new THREE.Quaternion().setFromRotationMatrix(camLookMatrix);
      camera.quaternion.slerp(camTargetQuat, 0.68);

    } else if (controlMode === 'click' && targetPosition) {
      const currentPos = playerRef.current.position;
      const adjustedTarget = targetPosition.clone().normalize().multiplyScalar(radius);
      const distance = currentPos.distanceTo(adjustedTarget);
      isMoving = distance > 0.02;

      if (isMoving) {
        currentPos.lerp(adjustedTarget, 0.05);
        currentPos.normalize().multiplyScalar(radius); 
        const upNormal = currentPos.clone().normalize();
        const lookAtMatrix = new THREE.Matrix4();
        lookAtMatrix.lookAt(currentPos, adjustedTarget, upNormal);
        playerRef.current.quaternion.setFromRotationMatrix(lookAtMatrix);
        playerPos.current.copy(currentPos);
      }
    }

    if (isMoving && !isPlacingFlag.current) {
      const t = clock.getElapsedTime() * 12; 
      const angle = 0.5; 
      if (!isOnWater) {
        if (legL.current) legL.current.rotation.x = Math.sin(t) * angle;
        if (legR.current) legR.current.rotation.x = Math.sin(t + Math.PI) * angle;
        if (armL.current) armL.current.rotation.x = Math.sin(t + Math.PI) * angle;
        if (armR.current) armR.current.rotation.x = Math.sin(t) * angle;
        // Rebond du buste : deux "rebonds" par cycle de jambe (un par appui au
        // sol) + une légère inclinaison vers l'avant, pour casser l'effet
        // "glisse sur des rails" d'un simple sin() sur les membres.
        walkAnim.current.bob = Math.abs(Math.sin(t)) * 0.018;
        walkAnim.current.lean = THREE.MathUtils.lerp(walkAnim.current.lean, -0.07, 0.15);
      } else {
        if (oarRef.current) oarRef.current.rotation.z = Math.sin(t) * 0.4;
      }
    } else if (!isPlacingFlag.current) {
      if (legL.current) {
        legL.current.rotation.x = THREE.MathUtils.lerp(legL.current.rotation.x, 0, 0.1);
        legR.current.rotation.x = THREE.MathUtils.lerp(legR.current.rotation.x, 0, 0.1);
        armL.current.rotation.x = THREE.MathUtils.lerp(armL.current.rotation.x, 0, 0.1);
        armR.current.rotation.x = THREE.MathUtils.lerp(armR.current.rotation.x, 0, 0.1);
      }
      if (oarRef.current) {
        oarRef.current.rotation.z = THREE.MathUtils.lerp(oarRef.current.rotation.z, 0, 0.1);
      }
      walkAnim.current.bob = THREE.MathUtils.lerp(walkAnim.current.bob, 0, 0.15);
      walkAnim.current.lean = THREE.MathUtils.lerp(walkAnim.current.lean, 0, 0.15);
    }

    // Anime le pool de particules d'éclaboussure (mouvement + amortissement +
    // fondu), indépendamment du mode de contrôle courant.
    splashData.current.forEach((p, i) => {
      const mesh = splashMeshes.current[i];
      if (!mesh) return;
      if (p.life < p.maxLife) {
        p.life += delta;
        p.pos.addScaledVector(p.vel, delta * 60);
        p.vel.multiplyScalar(0.9);
        const lifeT = p.life / p.maxLife;
        mesh.visible = true;
        mesh.position.copy(p.pos);
        const s = THREE.MathUtils.lerp(1, 0.15, lifeT);
        mesh.scale.setScalar(s);
        if (mesh.material) mesh.material.opacity = 1 - lifeT;
      } else if (mesh.visible) {
        mesh.visible = false;
      }
    });
  });

  return (
    <>
      <group ref={playerRef} position={[0, 5.12, 0]}>
        {isOnWater ? (
          <BoatWithRider oarRef={oarRef} transitionProgress={transitionProgress} />
        ) : (
          <Stickman
            legL={legL}
            legR={legR}
            armL={armL}
            armR={armR}
            bodyRef={bodyRef}
            showFlagInHand={showFlagInHand}
            transitionProgress={transitionProgress}
            walkBob={walkAnim.current.bob}
            walkLean={walkAnim.current.lean}
          />
        )}
      </group>
      <SplashParticles meshesRef={splashMeshes} count={SPLASH_COUNT} />
    </>
  );
};

// Rendu séparé du pool de particules d'éclaboussure : ce groupe reste en
// coordonnées MONDE (pas d'attache au joueur), sinon les particules
// hériteraient de sa rotation et partiraient dans le mauvais sens.
const SplashParticles = ({ meshesRef, count }) => (
  <group>
    {Array.from({ length: count }).map((_, i) => (
      <mesh key={i} ref={(el) => { if (el) meshesRef.current[i] = el; }} visible={false}>
        <sphereGeometry args={[0.03, 6, 6]} />
        <meshBasicMaterial color="#BFDBFE" transparent opacity={0} depthWrite={false} />
      </mesh>
    ))}
  </group>
);

// 6. Un Pays Individuel
const CountryMesh = ({ feature, onHover, onClick, controlMode, activeCountry }) => {
  const [hovered, setHovered] = useState(false);

  const geometries = useMemo(() => {
    const parts = [];
    const type = feature.geometry.type;
    const coordinates = type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;

    coordinates.forEach((polygonCoords) => {
      const outerRing = polygonCoords[0];
      if (!outerRing || outerRing.length < 3) return;

      const shape = new THREE.Shape();
      outerRing.forEach(([lon, lat], index) => {
        if (index === 0) shape.moveTo(lon, lat);
        else shape.lineTo(lon, lat);
      });

      const extrudeSettings = { depth: 0.08, bevelEnabled: false };
      const meshGeom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
      projectGeometryToSphere(meshGeom, 5);

      const borderPoints = [];
      outerRing.forEach(([lon, lat]) => {
        const r = 5.082; 
        const phi = (90 - lat) * (Math.PI / 180);
        const theta = (lon + 180) * (Math.PI / 180);
        const x = -(r * Math.sin(phi) * Math.cos(theta));
        const z = (r * Math.sin(phi) * Math.sin(theta));
        const y = (r * Math.cos(phi));
        borderPoints.push(new THREE.Vector3(x, y, z));
      });
      const lineGeom = new THREE.BufferGeometry().setFromPoints(borderPoints);

      parts.push({ meshGeom, lineGeom });
    });
    return parts;
  }, [feature]);

  const countryName = feature.properties.name || 'Pays inconnu';
  const isHighlighted = hovered || countryName === activeCountry;
  const displayColor = isHighlighted ? (countryColorsData[countryName] || '#FACC15') : '#4ADE80';

  return (
    <group
      onPointerEnter={(e) => { 
        if (controlMode === 'click') { e.stopPropagation(); setHovered(true); onHover(countryName); }
      }}
      onPointerLeave={(e) => { 
        if (controlMode === 'click') { e.stopPropagation(); setHovered(false); onHover(null); }
      }}
      onClick={(e) => { 
        if (controlMode === 'click') {
          e.stopPropagation(); 
          onClick(countryName, e.point); 
        }
      }}
    >
      {geometries.map((part, idx) => (
        <group key={idx}>
          <mesh geometry={part.meshGeom}>
            <meshStandardMaterial color={displayColor} flatShading={true} roughness={0.6} />
          </mesh>
          <line geometry={part.lineGeom} raycast={() => null}>
            <lineBasicMaterial color="#000000" opacity={0.6} transparent={true} />
          </line>
        </group>
      ))}
    </group>
  );
};

// 7. Globe Combiné
const GlobeWithCountries = ({ onHoverCountry, onClickCountry, controlMode, setCountriesData, activeCountry }) => {
  const [countries, setCountries] = useState([]);

  useEffect(() => {
    fetch('https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json')
      .then((res) => res.json())
      .then((data) => {
        setCountries(data.features);
        if (setCountriesData) setCountriesData(data.features);
      })
      .catch((err) => console.error('Erreur GeoJSON:', err));
  }, [setCountriesData]);

  return (
    <group>
      <mesh receiveShadow castShadow>
        <icosahedronGeometry args={[4.95, 12]} />
        {/* MeshDistortMaterial anime une déformation subtile en continu : donne
            une impression d'océan "vivant" sans coût de simulation physique. */}
        <MeshDistortMaterial
          color="#1E40AF"
          flatShading={true}
          roughness={0.75}
          metalness={0.1}
          distort={0.035}
          speed={0.8}
        />
      </mesh>

      {countries.map((feature, index) => (
        <CountryMesh 
          key={feature.id || index} 
          feature={feature} 
          onHover={onHoverCountry}
          onClick={onClickCountry}
          controlMode={controlMode}
          activeCountry={activeCountry}
        />
      ))}
    </group>
  );
};

// 8. Composant Principal
const TravelPortfolioScene = () => {
  const [hoveredCountry, setHoveredCountry] = useState(null);
  const [selectedCountry, setSelectedCountry] = useState(null);
  const [targetPosition, setTargetPosition] = useState(null);
  const [controlMode, setControlMode] = useState('click');
  const [countriesData, setCountriesData] = useState([]);
  const [isOnWater, setIsOnWater] = useState(false);
  
  const [visitedFlags, setVisitedFlags] = useState([]);
  const [activePopupFlag, setActivePopupFlag] = useState(null);
  const [noteContent, setNoteContent] = useState('');

  const handlePlantFlag = (position) => {
    if (!selectedCountry || isOnWater) return;
    if (!visitedFlags.some(f => f.country === selectedCountry)) {
      setVisitedFlags(prev => [...prev, { country: selectedCountry, position, notes: 'Mes notes de voyage ici...' }]);
    }
  };

  const openCountryNote = (name) => {
    const found = visitedFlags.find(f => f.country === name);
    if (found) {
      setActivePopupFlag(found);
      setNoteContent(found.notes);
    }
  };

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#090d16', overflow: 'hidden', position: 'relative' }}>
      
      {/* Boutons de Contrôle */}
      <div style={{ position: 'absolute', top: 30, right: 30, zIndex: 10, display: 'flex', gap: '10px', background: 'rgba(255,255,255,0.1)', padding: '6px', borderRadius: '10px', backdropFilter: 'blur(10px)' }}>
        <button 
          onClick={() => setControlMode('click')}
          style={{ padding: '8px 16px', borderRadius: '6px', border: 'none', background: controlMode === 'click' ? '#4ADE80' : 'transparent', color: controlMode === 'click' ? '#000' : '#fff', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}
        >
          Mode Clic 🖱️
        </button>
        <button 
          onClick={() => setControlMode('zqsd')}
          style={{ padding: '8px 16px', borderRadius: '6px', border: 'none', background: controlMode === 'zqsd' ? '#4ADE80' : 'transparent', color: controlMode === 'zqsd' ? '#000' : '#fff', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}
        >
          Mode ZQSD ⌨️
        </button>
      </div>

      {/* Panneau latéral des pays visités */}
      <div style={{ position: 'absolute', top: 110, right: 30, zIndex: 10, width: '220px', background: 'rgba(15, 23, 42, 0.85)', border: '1px solid rgba(255,255,255,0.15)', padding: '15px', borderRadius: '12px', backdropFilter: 'blur(10px)', color: '#fff' }}>
        <h3 style={{ margin: '0 0 10px 0', fontSize: '15px', color: '#4ADE80' }}>Pays visités</h3>
        {visitedFlags.length === 0 ? (
          <p style={{ margin: 0, fontSize: '12px', opacity: 0.6 }}>Aucun drapeau planté.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {visitedFlags.map((flag, idx) => (
              <li key={idx} style={{ fontSize: '13px' }}>
                <span 
                  onClick={() => openCountryNote(flag.country)}
                  style={{ cursor: 'pointer', textDecoration: 'underline', color: '#60A5FA' }}
                >
                  {flag.country}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Compteur de pays visités en bas à gauche */}
      <div style={{ position: 'absolute', bottom: 30, left: 30, zIndex: 10, background: 'rgba(15, 23, 42, 0.85)', border: '1px solid rgba(255,255,255,0.15)', padding: '10px 16px', borderRadius: '10px', color: '#fff', backdropFilter: 'blur(10px)', fontSize: '14px', fontWeight: 'bold' }}>
        {visitedFlags.length} pays visité{visitedFlags.length > 1 ? 's' : ''}
      </div>

      <Canvas shadows camera={{ position: [0, 0, 14], fov: 45 }}>
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 10, 5]} intensity={1.5} castShadow />
        <directionalLight position={[-10, -10, -5]} intensity={0.3} color="#90b0d0" />

        <Stars radius={100} depth={50} count={3000} factor={4} fade />
        
        <Player 
          targetPosition={targetPosition} 
          controlMode={controlMode} 
          countriesData={countriesData}
          onWaterChange={setIsOnWater}
          onLocationChange={(countryName) => {
            if (controlMode === 'zqsd') {
              setSelectedCountry(countryName);
            }
          }}
          onPlantFlag={handlePlantFlag}
          visitedFlags={visitedFlags}
        />

        <GlobeWithCountries 
          onHoverCountry={setHoveredCountry} 
          onClickCountry={(name, point) => {
            if (controlMode === 'click') {
              setSelectedCountry(name);
              setTargetPosition(point);
            }
          }} 
          controlMode={controlMode}
          setCountriesData={setCountriesData}
          activeCountry={selectedCountry}
        />

        {visitedFlags.map((flag, idx) => (
          <FlagMarker 
            key={idx} 
            position={flag.position} 
            countryName={flag.country} 
            onClick={openCountryNote} 
          />
        ))}
        
        <OrbitControls enablePan={false} enableRotate={controlMode === 'click'} minDistance={6} maxDistance={20} />
      </Canvas>

      {/* Pop-up des Notes */}
      {activePopupFlag && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: '320px', background: 'rgba(15, 23, 42, 0.95)', border: '1px solid rgba(255,255,255,0.2)', padding: '20px', borderRadius: '12px', zIndex: 100, color: '#fff', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)' }}>
          <h2 style={{ margin: '0 0 10px 0', fontSize: '20px', color: '#4ADE80' }}>Drapeau : {activePopupFlag.country}</h2>
          <p style={{ margin: '0 0 10px 0', fontSize: '13px', opacity: 0.8 }}>Remplissez vos souvenirs ou infos pour ce pays :</p>
          <textarea 
            value={noteContent} 
            onChange={(e) => setNoteContent(e.target.value)}
            style={{ width: '100%', height: '100px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '6px', color: '#fff', padding: '10px', resize: 'none', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '15px' }}>
            <button 
              onClick={() => {
                setVisitedFlags(visitedFlags.map(f => f.country === activePopupFlag.country ? { ...f, notes: noteContent } : f));
                setActivePopupFlag(null);
              }}
              style={{ padding: '6px 12px', background: '#4ADE80', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}
            >
              Enregistrer
            </button>
            <button 
              onClick={() => setActivePopupFlag(null)}
              style={{ padding: '6px 12px', background: 'rgba(255,255,255,0.2)', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
            >
              Fermer
            </button>
          </div>
        </div>
      )}
      
      {/* Titre et Instructions */}
      <div style={{ position: 'absolute', top: 30, left: 30, color: 'white', fontFamily: 'system-ui, sans-serif', pointerEvents: 'none' }}>
        <h1 style={{ margin: 0, fontSize: '28px', fontWeight: 'bold' }}>Globe Explorateur</h1>
        <p style={{ margin: '5px 0 0 0', opacity: 0.8 }}>
          {controlMode === 'click' 
            ? (hoveredCountry ? `📍 Survol : ${hoveredCountry}` : 'Cliquez sur un pays pour y voyager !')
            : (isOnWater ? '🌊 En navigation (Chaloupe)' : `🚶‍♂️ Territoire : ${selectedCountry || 'Inconnu'} ${visitedFlags.some(f => f.country === selectedCountry) ? '(Drapeau déjà posé)' : '(Appuyez sur ESPACE pour planter un drapeau)'}`)}
        </p>
      </div>
    </div>
  );
};

export default TravelPortfolioScene;