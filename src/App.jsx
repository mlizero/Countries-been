import React, { useRef, useState, useEffect, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Stars, RoundedBox, MeshDistortMaterial, Html } from '@react-three/drei';
import * as THREE from 'three';
import countryColorsData from './countriesColors.json';

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

// Un polygone de pays n'a souvent que quelques sommets espacés de dizaines de
// degrés (dataset volontairement low-poly). Or projectGeometryToSphere ne
// déplace QUE les sommets sur la sphère : les faces plates ENTRE deux sommets
// éloignés restent des cordes qui "coupent" sous la surface de la sphère
// (le milieu d'un grand triangle plat est plus proche du centre que ses
// coins). Pour un grand pays (Russie, Canada...), cet affaissement peut
// largement dépasser la marge de 0.05 laissée avant l'océan, et le pays
// semble alors passer sous l'eau en son centre. On corrige en insérant des
// points intermédiaires le long des arêtes du polygone AVANT extrusion, pour
// qu'aucun triangle ne couvre plus que `maxStepDeg` degrés d'un coup.
function densifyRing(ring, maxStepDeg = 3) {
  if (!ring || ring.length < 2) return ring;
  const out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    out.push([lon1, lat1]);
    const dLon = lon2 - lon1;
    const dLat = lat2 - lat1;
    if (Math.abs(dLon) > 180) continue; // évite les faux raccords à l'antiméridien
    const dist = Math.sqrt(dLon * dLon + dLat * dLat);
    const steps = Math.min(20, Math.max(1, Math.ceil(dist / maxStepDeg)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      out.push([lon1 + dLon * t, lat1 + dLat * t]);
    }
  }
  out.push(ring[ring.length - 1]);
  return out;
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
const Stickman = ({ legL, legR, armL, armR, bodyRef, showFlagInHand }) => {
  const skinColor = "#FFC3A0"; 
  const shirtColor = "#FF5733"; 
  const pantsColor = "#1E40AF"; 
  const hairColor = "#3B2412";

  return (
    <group ref={bodyRef} position={[0, 0.15, 0]}>
      {/* Tête */}
      <RoundedBox args={[0.1, 0.1, 0.1]} radius={0.022} smoothness={3} position={[0, 0.25, 0]} castShadow>
        <meshStandardMaterial color={skinColor} flatShading={true} />
      </RoundedBox>
      {/* Petite touffe de cheveux */}
      <mesh position={[0, 0.305, -0.005]} castShadow>
        <sphereGeometry args={[0.052, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
        <meshStandardMaterial color={hairColor} flatShading={true} />
      </mesh>
      {/* Yeux */}
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

// Anime la caméra vers un pays sélectionné (zoom façon Google Maps / Wanderlog),
// puis la ramène à sa position précédente à la fermeture. Se monte à
// l'intérieur du <Canvas> pour avoir accès à `camera` via useThree.
const CameraFocusRig = ({ focusFlag, onSettled }) => {
  const { camera } = useThree();
  const savedPos = useRef(null);
  const wasFocused = useRef(false);

  useEffect(() => {
    if (focusFlag && !wasFocused.current) {
      // On démarre un zoom : on mémorise d'où on partait pour pouvoir y revenir.
      savedPos.current = camera.position.clone();
    }
    wasFocused.current = !!focusFlag;
  }, [focusFlag, camera]);

  useFrame(() => {
    if (focusFlag) {
      const pos = focusFlag.position;
      const normal = pos.clone().normalize();
      let tangent = new THREE.Vector3(0, 1, 0).sub(normal.clone().multiplyScalar(normal.y));
      if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0);
      tangent.normalize();
      // Position la caméra au-dessus du pays, légèrement en retrait pour un
      // angle de vue 3/4 plutôt qu'un plongée verticale plate.
      const target = pos.clone()
        .add(normal.clone().multiplyScalar(2.3))
        .sub(tangent.clone().multiplyScalar(1.15));
      camera.position.lerp(target, 0.07);
      camera.up.lerp(normal, 0.1);
      camera.lookAt(pos);
    } else if (savedPos.current) {
      camera.position.lerp(savedPos.current, 0.09);
      camera.up.lerp(new THREE.Vector3(0, 1, 0), 0.09);
      camera.lookAt(0, 0, 0);
      if (camera.position.distanceTo(savedPos.current) < 0.05) {
        savedPos.current = null;
        if (onSettled) onSettled();
      }
    }
  });

  return null;
};

// Grand nom du pays flottant au-dessus du point zoomé sur le globe (ancré en
// coordonnées 3D via drei/Html, donc reste "collé" au bon endroit du globe).
const CountryZoomLabel = ({ flag }) => {
  if (!flag) return null;
  return (
    <Html position={flag.position} center distanceFactor={6} zIndexRange={[5, 0]} occlude>
      <div
        key={flag.country}
        style={{
          fontSize: 26, fontWeight: 800, color: '#fff', whiteSpace: 'nowrap',
          textShadow: '0 2px 12px rgba(0,0,0,0.85), 0 0 30px rgba(74,222,128,0.5)',
          fontFamily: 'system-ui, sans-serif', pointerEvents: 'none',
          animation: 'countryLabelIn 0.5s cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
        {flag.country}
      </div>
    </Html>
  );
};

// Notation sur 10, en étoiles cliquables avec prévisualisation au survol.
const RatingStars = ({ value = 0, onChange, size = 18 }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <div style={{ display: 'flex', gap: 2 }}>
      {Array.from({ length: 10 }).map((_, i) => {
        const idx = i + 1;
        return (
          <span
            key={idx}
            onClick={() => onChange(idx === value ? 0 : idx)}
            style={{
              cursor: 'pointer', fontSize: size, lineHeight: 1,
              color: idx <= value ? '#FACC15' : 'rgba(255,255,255,0.25)',
              transition: 'color 0.15s, transform 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
          >
            ★
          </span>
        );
      })}
    </div>
    <span style={{ fontSize: 13, opacity: 0.7, minWidth: 32 }}>{value}/10</span>
  </div>
);


const Player = ({ targetPosition, controlMode, countriesData, onWaterChange, onLocationChange, onPlantFlag, visitedFlags, cameraLocked }) => {
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
  const [transitionProgress, setTransitionProgress] = useState(0);
  
  const isPlacingFlag = useRef(false);
  const plantAnimTime = useRef(0);
  const currentCountryRef = useRef(null);
  const prevWaterState = useRef(false);
  const transitionStartTime = useRef(0);
  const pendingWaterState = useRef(null);
  const pendingSince = useRef(0);
  const WATER_STATE_DEBOUNCE = 0.22;

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

  useFrame(({ clock }) => {
    if (!playerRef.current) return;

    let isMoving = false;
    const radius = 5.12;

    if (controlMode === 'zqsd') {
      const moveSpeed = 0.035;
      const rotateSpeed = 0.04;

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
      const nowT = clock.getElapsedTime();

      if (rawWaterState !== prevWaterState.current) {
        if (pendingWaterState.current !== rawWaterState) {
          pendingWaterState.current = rawWaterState;
          pendingSince.current = nowT;
        } else if (nowT - pendingSince.current > WATER_STATE_DEBOUNCE) {
          prevWaterState.current = rawWaterState;
          transitionStartTime.current = nowT;
          pendingWaterState.current = null;
        }
      } else {
        pendingWaterState.current = null;
      }
      const waterState = prevWaterState.current;

      const tTrans = nowT - transitionStartTime.current;
      const progress = Math.min(1, tTrans / 0.6);
      setTransitionProgress(waterState ? progress : (1 - progress));

      setIsOnWater(waterState);
      if (onWaterChange) onWaterChange(waterState);
      if (onLocationChange) onLocationChange(currentCountry);

      const backwardDir = playerDir.current.clone().negate();
      const idealCameraPos = playerPos.current.clone()
        .add(backwardDir.multiplyScalar(2.8))
        .add(upNormal.multiplyScalar(5.0));

      if (!cameraLocked) {
        camera.position.lerp(idealCameraPos, 0.15);
        camera.up.copy(upNormal);
        camera.lookAt(playerPos.current);
      }

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
    }
  });

  return (
    <group ref={playerRef} position={[0, 5.12, 0]}>
      {isOnWater ? (
        <BoatWithRider oarRef={oarRef} transitionProgress={transitionProgress} />
      ) : (
        <Stickman legL={legL} legR={legR} armL={armL} armR={armR} bodyRef={bodyRef} showFlagInHand={showFlagInHand} />
      )}
    </group>
  );
};

// 6. Un Pays Individuel
const CountryMesh = ({ feature, onHover, onClick, controlMode, activeCountry }) => {
  const [hovered, setHovered] = useState(false);

  const geometries = useMemo(() => {
    const parts = [];
    const type = feature.geometry.type;
    const coordinates = type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;

    coordinates.forEach((polygonCoords) => {
      const rawRing = polygonCoords[0];
      if (!rawRing || rawRing.length < 3) return;
      const outerRing = densifyRing(rawRing, 3);

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
  const [returningCamera, setReturningCamera] = useState(false);

  // Contenu éditable du panneau (brouillon local tant qu'on n'a pas cliqué "Enregistrer")
  const [panelNotes, setPanelNotes] = useState('');
  const [panelRating, setPanelRating] = useState(0);
  const [panelPhotos, setPanelPhotos] = useState([]);

  // Fiche Wikipédia (photo de couverture + extrait) du pays affiché dans le panneau
  const [wikiInfo, setWikiInfo] = useState(null);
  const [wikiLoading, setWikiLoading] = useState(false);

  const cameraLocked = !!activePopupFlag || returningCamera;

  const handlePlantFlag = (position) => {
    if (!selectedCountry || isOnWater) return;
    if (!visitedFlags.some(f => f.country === selectedCountry)) {
      setVisitedFlags(prev => [...prev, { country: selectedCountry, position, notes: '', rating: 0, photos: [] }]);
    }
  };

  const openCountryNote = (name) => {
    const found = visitedFlags.find(f => f.country === name);
    if (found) {
      setActivePopupFlag(found);
      setPanelNotes(found.notes || '');
      setPanelRating(found.rating || 0);
      setPanelPhotos(found.photos || []);
    }
  };

  const closePanel = () => {
    setActivePopupFlag(null);
    setReturningCamera(true);
  };

  const savePanel = () => {
    if (!activePopupFlag) return;
    setVisitedFlags(prev => prev.map(f =>
      f.country === activePopupFlag.country
        ? { ...f, notes: panelNotes, rating: panelRating, photos: panelPhotos }
        : f
    ));
    closePanel();
  };

  const deleteFlag = (countryName) => {
    if (!window.confirm(`Supprimer le drapeau planté sur ${countryName} ? Cette action est irréversible.`)) return;
    setVisitedFlags(prev => prev.filter(f => f.country !== countryName));
    if (activePopupFlag?.country === countryName) closePanel();
  };

  const handlePhotoUpload = (e) => {
    const files = Array.from(e.target.files || []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => setPanelPhotos((prev) => [...prev, reader.result]);
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const removePanelPhoto = (idx) => {
    setPanelPhotos((prev) => prev.filter((_, i) => i !== idx));
  };

  // Récupère une photo de couverture + un court résumé depuis Wikipédia pour
  // le pays actuellement affiché dans le panneau (API publique, sans clé).
  useEffect(() => {
    if (!activePopupFlag) return;
    let cancelled = false;
    setWikiInfo(null);
    setWikiLoading(true);
    fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(activePopupFlag.country)}`)
      .then((res) => { if (!res.ok) throw new Error('not found'); return res.json(); })
      .then((data) => {
        if (cancelled) return;
        setWikiInfo({
          thumbnail: data.thumbnail?.source || data.originalimage?.source || null,
          extract: data.extract || '',
          pageUrl: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(activePopupFlag.country)}`,
        });
      })
      .catch(() => { if (!cancelled) setWikiInfo(null); })
      .finally(() => { if (!cancelled) setWikiLoading(false); });
    return () => { cancelled = true; };
  }, [activePopupFlag?.country]);


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
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {visitedFlags.map((flag, idx) => (
              <li key={idx} style={{ fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span 
                  onClick={() => openCountryNote(flag.country)}
                  style={{ cursor: 'pointer', textDecoration: 'underline', color: '#60A5FA', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {flag.country}{flag.rating > 0 ? ` · ${flag.rating}/10` : ''}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteFlag(flag.country); }}
                  title="Supprimer ce drapeau"
                  style={{ flexShrink: 0, background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 14, padding: '0 2px' }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = '#EF4444'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; }}
                >
                  ✕
                </button>
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
          cameraLocked={cameraLocked}
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

        <CameraFocusRig focusFlag={activePopupFlag} onSettled={() => setReturningCamera(false)} />
        <CountryZoomLabel flag={activePopupFlag} />
        
        {!cameraLocked && (
          <OrbitControls enablePan={false} enableRotate={controlMode === 'click'} minDistance={6} maxDistance={20} />
        )}
      </Canvas>

      {/* Animations CSS (label géant sur le globe + glissement du panneau) */}
      <style>{`
        @keyframes countryLabelIn {
          from { opacity: 0; transform: scale(0.7) translateY(10px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes panelFadeIn {
          from { opacity: 0; transform: translateX(24px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>

      {/* Panneau latéral façon Wanderlog / Google Maps : infos + notes du pays */}
      {activePopupFlag && (
        <div
          key={activePopupFlag.country}
          style={{
            position: 'absolute', top: 0, right: 0, height: '100vh', width: 380, maxWidth: '92vw',
            background: 'rgba(15, 23, 42, 0.97)', borderLeft: '1px solid rgba(255,255,255,0.15)',
            zIndex: 100, color: '#fff', boxShadow: '-20px 0 40px -10px rgba(0,0,0,0.6)',
            display: 'flex', flexDirection: 'column', animation: 'panelFadeIn 0.35s cubic-bezier(0.2,0.8,0.2,1)',
          }}
        >
          {/* Photo de couverture (Wikipédia) */}
          <div style={{ position: 'relative', width: '100%', height: 190, flexShrink: 0, background: '#1e293b' }}>
            {wikiLoading && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, opacity: 0.6 }}>
                Chargement de la photo...
              </div>
            )}
            {!wikiLoading && wikiInfo?.thumbnail && (
              <img src={wikiInfo.thumbnail} alt={activePopupFlag.country} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            )}
            {!wikiLoading && !wikiInfo?.thumbnail && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 40, opacity: 0.3 }}>
                🌍
              </div>
            )}
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(15,23,42,0.95) 100%)' }} />
            <button
              onClick={closePanel}
              style={{ position: 'absolute', top: 14, right: 14, width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.5)', color: '#fff', cursor: 'pointer', fontSize: 16, lineHeight: '32px', textAlign: 'center' }}
            >
              ✕
            </button>
            <h2 style={{ position: 'absolute', bottom: 12, left: 18, margin: 0, fontSize: 24, fontWeight: 800 }}>
              {activePopupFlag.country}
            </h2>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px 90px' }}>
            {/* Extrait Wikipédia */}
            {wikiInfo?.extract && (
              <p style={{ margin: '0 0 16px 0', fontSize: 12.5, lineHeight: 1.5, opacity: 0.75 }}>
                {wikiInfo.extract.length > 280 ? wikiInfo.extract.slice(0, 280) + '…' : wikiInfo.extract}
                {' '}
                <a href={wikiInfo.pageUrl} target="_blank" rel="noreferrer" style={{ color: '#60A5FA' }}>Wikipédia ↗</a>
              </p>
            )}

            {/* Ma note sur 10 */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.6, marginBottom: 6 }}>Ma note</div>
              <RatingStars value={panelRating} onChange={setPanelRating} />
            </div>

            {/* Mes photos de voyage */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.6, marginBottom: 8 }}>Mes photos</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {panelPhotos.map((src, idx) => (
                  <div key={idx} style={{ position: 'relative', paddingTop: '100%', borderRadius: 8, overflow: 'hidden', background: '#1e293b' }}>
                    <img src={src} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                    <button
                      onClick={() => removePanelPhoto(idx)}
                      title="Supprimer cette photo"
                      style={{ position: 'absolute', top: 3, right: 3, width: 20, height: 20, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.65)', color: '#fff', fontSize: 11, cursor: 'pointer', lineHeight: '20px', textAlign: 'center', padding: 0 }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <label
                  style={{
                    paddingTop: '100%', position: 'relative', borderRadius: 8, cursor: 'pointer',
                    border: '1.5px dashed rgba(255,255,255,0.25)', display: 'block',
                  }}
                >
                  <input type="file" accept="image/*" multiple onChange={handlePhotoUpload} style={{ display: 'none' }} />
                  <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, opacity: 0.5 }}>
                    +
                  </span>
                </label>
              </div>
            </div>

            {/* Mes notes */}
            <div>
              <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.6, marginBottom: 8 }}>Mes souvenirs</div>
              <textarea 
                value={panelNotes} 
                onChange={(e) => setPanelNotes(e.target.value)}
                placeholder="Écrivez vos souvenirs, anecdotes, adresses à retenir..."
                style={{ width: '100%', height: '140px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '8px', color: '#fff', padding: '10px', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 13 }}
              />
            </div>
          </div>

          {/* Barre d'actions fixe en bas du panneau */}
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', gap: 10, padding: 16, background: 'rgba(15, 23, 42, 0.97)', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
            <button 
              onClick={savePanel}
              style={{ flex: 1, padding: '10px 12px', background: '#4ADE80', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
            >
              Enregistrer
            </button>
            <button 
              onClick={() => deleteFlag(activePopupFlag.country)}
              title="Supprimer ce drapeau"
              style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.15)', color: '#EF4444', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '8px', cursor: 'pointer' }}
            >
              🗑
            </button>
            <button 
              onClick={closePanel}
              style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
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