import React, { useRef, useState, useEffect, useMemo, useContext } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Stars, RoundedBox, MeshDistortMaterial, Html } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
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
// --- Persistance locale (IndexedDB) -----------------------------------
// On utilise IndexedDB plutôt que localStorage car les photos sont stockées
// en base64 dans les notes : le quota de localStorage (~5-10 Mo au total)
// serait vite dépassé, alors qu'IndexedDB tient largement plus (centaines
// de Mo selon le navigateur). Un vrai "compte" multi-appareils demanderait
// un serveur + une authentification + une base de données — hors de portée
// pour ce fichier front-end seul. Ceci couvre "je ferme et je rouvre le
// navigateur, mes données sont toujours là" sur le même appareil.
const IDB_NAME = 'countries-been-db';
const IDB_STORE = 'data';
const IDB_KEY = 'visitedFlags';
const IDB_GEO_STORE = 'geometryCache';
// Incrémenter cette version invalide tout le cache géométrique existant —
// utile si un jour l'algorithme de subdivision/projection change encore
// (sinon on resservirait indéfiniment de vieilles géométries obsolètes).
const GEOMETRY_CACHE_VERSION = 1;

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      if (!db.objectStoreNames.contains(IDB_GEO_STORE)) db.createObjectStore(IDB_GEO_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- Cache des géométries de pays (fix "niveau de la mer") --------------
// La subdivision + triangulation + projection sphérique de chaque pays est
// le calcul le plus coûteux au démarrage (jusqu'à ~13 000 triangles pour un
// grand pays comme l'Antarctique). On le met en cache dans IndexedDB par
// pays (clé = id ISO3 du GeoJSON) pour ne le refaire qu'une seule fois,
// jamais à chaque rechargement de page.
async function idbGetGeometry(countryId) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_GEO_STORE, 'readonly');
      const req = tx.objectStore(IDB_GEO_STORE).get(`${GEOMETRY_CACHE_VERSION}:${countryId}`);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbSetGeometry(countryId, parts) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_GEO_STORE, 'readwrite');
      tx.objectStore(IDB_GEO_STORE).put(parts, `${GEOMETRY_CACHE_VERSION}:${countryId}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Pas grave si le cache échoue (quota plein, navigateur restrictif...) :
    // on retombe simplement sur un recalcul au prochain chargement.
  }
}

async function idbLoadFlags() {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error('Erreur de chargement des données sauvegardées :', err);
    return null;
  }
}

async function idbSaveFlags(flags) {
  try {
    const db = await idbOpen();
    // Les positions sont des THREE.Vector3 : on les sérialise en objets
    // simples {x,y,z} pour le stockage, on les reconstruira au chargement.
    const serializable = flags.map((f) => ({
      ...f,
      position: { x: f.position.x, y: f.position.y, z: f.position.z },
    }));
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(serializable, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (err) {
    console.error('Erreur de sauvegarde :', err);
    return false;
  }
}

async function idbClearFlags() {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (err) {
    console.error('Erreur de réinitialisation :', err);
    return false;
  }
}

// --- Paramètres (touches, graphismes, son) -----------------------------
// Stockés en localStorage plutôt qu'IndexedDB : c'est un tout petit objet
// sans photo, donc pas de souci de quota, et l'accès est synchrone (plus
// simple pour une valeur lue/écrite rarement).
const SETTINGS_KEY = 'countries-been-settings';
const DEFAULT_KEYBINDINGS = { forward: 'z', backward: 's', left: 'q', right: 'd', plant: ' ' };
const DEFAULT_SETTINGS = {
  keybindings: DEFAULT_KEYBINDINGS,
  bloom: true,
  shadows: true,
  reduceMotion: false,
  soundMuted: false,
  soundMaster: 0.7,
  soundFootsteps: true,
  soundOars: true,
  soundFlag: true,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    // Fusionne avec les valeurs par défaut : si une future mise à jour ajoute
    // un réglage, les anciennes sauvegardes ne cassent rien.
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      keybindings: { ...DEFAULT_KEYBINDINGS, ...(parsed.keybindings || {}) },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

const KEY_LABELS = { ' ': 'ESPACE', 'arrowup': '↑', 'arrowdown': '↓', 'arrowleft': '←', 'arrowright': '→' };
function formatKeyLabel(key) {
  if (!key) return '?';
  return KEY_LABELS[key.toLowerCase()] || key.toUpperCase();
}

// Le jeu de données GeoJSON ne fournit que le nom du pays (pas de continent),
// donc cette table est nécessaire pour les statistiques par continent.
// NB : quelques pays transcontinentaux (Russie, Turquie, Géorgie, Azerbaïdjan,
// Arménie, Chypre...) sont classés selon une convention courante mais
// discutable — à ajuster si besoin.
const COUNTRY_CONTINENTS = {
  Afghanistan: 'Asie', Albania: 'Europe', Algeria: 'Afrique', Angola: 'Afrique',
  Antarctica: 'Antarctique', Argentina: 'Amérique du Sud', Armenia: 'Asie',
  Australia: 'Océanie', Austria: 'Europe', Azerbaijan: 'Asie', Bangladesh: 'Asie',
  Belarus: 'Europe', Belgium: 'Europe', Belize: 'Amérique du Nord', Benin: 'Afrique',
  Bermuda: 'Amérique du Nord', Bhutan: 'Asie', Bolivia: 'Amérique du Sud',
  'Bosnia and Herzegovina': 'Europe', Botswana: 'Afrique', Brazil: 'Amérique du Sud',
  Brunei: 'Asie', Bulgaria: 'Europe', 'Burkina Faso': 'Afrique', Burundi: 'Afrique',
  Cambodia: 'Asie', Cameroon: 'Afrique', Canada: 'Amérique du Nord',
  'Central African Republic': 'Afrique', Chad: 'Afrique', Chile: 'Amérique du Sud',
  China: 'Asie', Colombia: 'Amérique du Sud', 'Costa Rica': 'Amérique du Nord',
  Croatia: 'Europe', Cuba: 'Amérique du Nord', Cyprus: 'Europe', 'Czech Republic': 'Europe',
  'Democratic Republic of the Congo': 'Afrique', Denmark: 'Europe', Djibouti: 'Afrique',
  'Dominican Republic': 'Amérique du Nord', 'East Timor': 'Asie', Ecuador: 'Amérique du Sud',
  Egypt: 'Afrique', 'El Salvador': 'Amérique du Nord', 'Equatorial Guinea': 'Afrique',
  Eritrea: 'Afrique', Estonia: 'Europe', Ethiopia: 'Afrique', 'Falkland Islands': 'Amérique du Sud',
  Fiji: 'Océanie', Finland: 'Europe', France: 'Europe', 'French Guiana': 'Amérique du Sud',
  'French Southern and Antarctic Lands': 'Antarctique', Gabon: 'Afrique', Gambia: 'Afrique',
  Georgia: 'Asie', Germany: 'Europe', Ghana: 'Afrique', Greece: 'Europe', Greenland: 'Amérique du Nord',
  Guatemala: 'Amérique du Nord', Guinea: 'Afrique', 'Guinea Bissau': 'Afrique', Guyana: 'Amérique du Sud',
  Haiti: 'Amérique du Nord', Honduras: 'Amérique du Nord', Hungary: 'Europe', Iceland: 'Europe',
  India: 'Asie', Indonesia: 'Asie', Iran: 'Asie', Iraq: 'Asie', Ireland: 'Europe', Israel: 'Asie',
  Italy: 'Europe', 'Ivory Coast': 'Afrique', Jamaica: 'Amérique du Nord', Japan: 'Asie',
  Jordan: 'Asie', Kazakhstan: 'Asie', Kenya: 'Afrique', Kosovo: 'Europe', Kuwait: 'Asie',
  Kyrgyzstan: 'Asie', Laos: 'Asie', Latvia: 'Europe', Lebanon: 'Asie', Lesotho: 'Afrique',
  Liberia: 'Afrique', Libya: 'Afrique', Lithuania: 'Europe', Luxembourg: 'Europe',
  Macedonia: 'Europe', Madagascar: 'Afrique', Malawi: 'Afrique', Malaysia: 'Asie', Mali: 'Afrique',
  Malta: 'Europe', Mauritania: 'Afrique', Mexico: 'Amérique du Nord', Moldova: 'Europe',
  Mongolia: 'Asie', Montenegro: 'Europe', Morocco: 'Afrique', Mozambique: 'Afrique',
  Myanmar: 'Asie', Namibia: 'Afrique', Nepal: 'Asie', Netherlands: 'Europe',
  'New Caledonia': 'Océanie', 'New Zealand': 'Océanie', Nicaragua: 'Amérique du Nord',
  Niger: 'Afrique', Nigeria: 'Afrique', 'North Korea': 'Asie', 'Northern Cyprus': 'Europe',
  Norway: 'Europe', Oman: 'Asie', Pakistan: 'Asie', Panama: 'Amérique du Nord',
  'Papua New Guinea': 'Océanie', Paraguay: 'Amérique du Sud', Peru: 'Amérique du Sud',
  Philippines: 'Asie', Poland: 'Europe', Portugal: 'Europe', 'Puerto Rico': 'Amérique du Nord',
  Qatar: 'Asie', 'Republic of Serbia': 'Europe', 'Republic of the Congo': 'Afrique',
  Romania: 'Europe', Russia: 'Europe', Rwanda: 'Afrique', 'Saudi Arabia': 'Asie',
  Senegal: 'Afrique', 'Sierra Leone': 'Afrique', Slovakia: 'Europe', Slovenia: 'Europe',
  'Solomon Islands': 'Océanie', Somalia: 'Afrique', Somaliland: 'Afrique', 'South Africa': 'Afrique',
  'South Korea': 'Asie', 'South Sudan': 'Afrique', Spain: 'Europe', 'Sri Lanka': 'Asie',
  Sudan: 'Afrique', Suriname: 'Amérique du Sud', Swaziland: 'Afrique', Sweden: 'Europe',
  Switzerland: 'Europe', Syria: 'Asie', Taiwan: 'Asie', Tajikistan: 'Asie', Thailand: 'Asie',
  'The Bahamas': 'Amérique du Nord', Togo: 'Afrique', 'Trinidad and Tobago': 'Amérique du Nord',
  Tunisia: 'Afrique', Turkey: 'Asie', Turkmenistan: 'Asie', Uganda: 'Afrique', Ukraine: 'Europe',
  'United Arab Emirates': 'Asie', 'United Kingdom': 'Europe', 'United Republic of Tanzania': 'Afrique',
  'United States of America': 'Amérique du Nord', Uruguay: 'Amérique du Sud', Uzbekistan: 'Asie',
  Vanuatu: 'Océanie', Venezuela: 'Amérique du Sud', Vietnam: 'Asie', 'West Bank': 'Asie',
  'Western Sahara': 'Afrique', Yemen: 'Asie', Zambia: 'Afrique', Zimbabwe: 'Afrique',
};

// Point représentatif d'un pays (pour la téléportation via la recherche) :
// centroïde du plus grand sous-polygone (le plus de sommets = la masse
// terrestre principale), projeté sur la sphère au rayon de marche du joueur.
function getCountryWalkPoint(feature, radius = 4.96) {
  const type = feature.geometry.type;
  const polygons = type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  let best = null;
  polygons.forEach((polygonCoords) => {
    const ring = polygonCoords[0];
    if (!ring || (best && ring.length <= best.length)) return;
    best = ring;
  });
  if (!best) return null;
  let sumLon = 0, sumLat = 0;
  const n = best.length - 1; // le dernier point ferme l'anneau (== le premier)
  for (let i = 0; i < n; i++) {
    sumLon += best[i][0];
    sumLat += best[i][1];
  }
  const lon = sumLon / n;
  const lat = sumLat / n;
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  const x = -(radius * Math.sin(phi) * Math.cos(theta));
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);
  return new THREE.Vector3(x, y, z);
}

// Récupère et parse le GeoJSON dans un Web Worker plutôt que sur le thread
// principal. Le fichier fait plusieurs Mo : le fetch ne bloque déjà rien
// (asynchrone), mais `JSON.parse()` d'une chaîne de plusieurs Mo, lui, EST
// synchrone et peut geler l'affichage un instant au démarrage. Le worker est
// créé à la volée via un Blob (pas besoin d'un fichier séparé à déployer) et
// n'a besoin que de `fetch`/`JSON.parse`, donc aucune dépendance à charger
// dans son contexte.
function fetchGeoJSONInWorker(url) {
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') {
      fetch(url).then((res) => res.json()).then(resolve).catch(reject);
      return;
    }
    const workerSource = `
      self.onmessage = async () => {
        try {
          const res = await fetch(${JSON.stringify(url)});
          const text = await res.text();
          const data = JSON.parse(text);
          self.postMessage({ ok: true, data });
        } catch (err) {
          self.postMessage({ ok: false, error: String((err && err.message) || err) });
        }
      };
    `;
    const blobUrl = URL.createObjectURL(new Blob([workerSource], { type: 'application/javascript' }));
    const worker = new Worker(blobUrl);
    worker.onmessage = (e) => {
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
      if (e.data.ok) resolve(e.data.data);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (err) => {
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
      reject(err);
    };
    worker.postMessage(null);
  });
}

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

// densifyRing() ne densifie que le CONTOUR du polygone. Mais la triangulation
// interne (earcut, utilisée par ExtrudeGeometry) peut quand même produire de
// grands triangles reliant des points du contour à travers l'INTÉRIEUR d'un
// pays très étendu (typiquement la Russie, dont la silhouette est large et
// simple) — même avec un contour dense. Ces grands triangles plats "coupent"
// sous la vraie courbure de la sphère en leur centre, ce qui donne
// l'impression que le pays passe sous le niveau de la mer alors que le
// joueur y est bien détecté (la détection, elle, utilise le contour 2D brut,
// pas le maillage 3D). On corrige ça en subdivisant TOUT le maillage (donc y
// compris les diagonales internes d'earcut) tant qu'une arête dépasse
// `maxEdgeLen` degrés, avant de le projeter sur la sphère.
function subdivideFlatGeometry(geometry, maxEdgeLen = 2.2, maxIterations = 6) {
  let positions = Array.from(geometry.attributes.position.array);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    const next = [];
    for (let i = 0; i < positions.length; i += 9) {
      const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
      const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
      const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
      const ab = Math.hypot(bx - ax, by - ay, bz - az);
      const bc = Math.hypot(cx - bx, cy - by, cz - bz);
      const ca = Math.hypot(ax - cx, ay - cy, az - cz);
      const longest = Math.max(ab, bc, ca);

      if (longest > maxEdgeLen) {
        changed = true;
        // Coupe le triangle en 2 au milieu de sa plus longue arête.
        if (longest === ab) {
          const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
          next.push(ax, ay, az, mx, my, mz, cx, cy, cz);
          next.push(mx, my, mz, bx, by, bz, cx, cy, cz);
        } else if (longest === bc) {
          const mx = (bx + cx) / 2, my = (by + cy) / 2, mz = (bz + cz) / 2;
          next.push(ax, ay, az, bx, by, bz, mx, my, mz);
          next.push(ax, ay, az, mx, my, mz, cx, cy, cz);
        } else {
          const mx = (cx + ax) / 2, my = (cy + ay) / 2, mz = (cz + az) / 2;
          next.push(ax, ay, az, bx, by, bz, mx, my, mz);
          next.push(mx, my, mz, bx, by, bz, cx, cy, cz);
        }
      } else {
        next.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      }
    }
    positions = next;
    if (!changed) break;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return out;
}

// Anime un pool de particules "simples" (position + vitesse + durée de vie),
// mutualisé entre l'éclaboussure, le sillage du bateau et la poussière des
// pas — seuls les réglages d'échelle/opacité/amortissement changent.
function updateParticlePool(dataArr, meshArr, delta, { scaleFrom = 1, scaleTo = 0.15, damping = 0.9, baseOpacity = 1 } = {}) {
  dataArr.forEach((p, i) => {
    const mesh = meshArr[i];
    if (!mesh) return;
    if (p.life < p.maxLife) {
      p.life += delta;
      p.pos.addScaledVector(p.vel, delta * 60);
      p.vel.multiplyScalar(damping);
      const lifeT = p.life / p.maxLife;
      mesh.visible = true;
      mesh.position.copy(p.pos);
      mesh.scale.setScalar(THREE.MathUtils.lerp(scaleFrom, scaleTo, lifeT));
      if (mesh.material) mesh.material.opacity = (1 - lifeT) * baseOpacity;
    } else if (mesh.visible) {
      mesh.visible = false;
    }
  });
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

// Easing "back out" : dépasse légèrement 1 puis revient, effet de rebond
// naturel utilisé pour l'arrivée sur la terre ferme après la chaloupe.
function easeOutBack(x) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
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
const Stickman = ({ legL, legR, armL, armR, bodyRef, headRef, showFlagInHand, transitionProgress = 1, walkBob = 0, walkLean = 0, walkTilt = 0 }) => {
  const skinColor = "#FFC3A0"; 
  const shirtColor = "#FF5733"; 
  const pantsColor = "#1E40AF"; 
  const hairColor = "#3B2412";

  // transitionProgress passe de 0 à 1 juste après avoir quitté la chaloupe :
  // fait "apparaître" le personnage sur la terre ferme avec un petit rebond
  // élastique au lieu d'un pop instantané.
  const p = Math.min(1, Math.max(0, transitionProgress));
  const landScale = THREE.MathUtils.lerp(0.4, 1, easeOutBack(p));
  const hopOffset = Math.sin(p * Math.PI) * 0.1;

  return (
    <group ref={bodyRef} position={[0, 0.15, 0]}>
      <group
        scale={[landScale, landScale, landScale]}
        position={[0, hopOffset + walkBob, 0]}
        rotation={[walkLean, 0, walkTilt]}
      >
      {/* Tête (groupe séparé pour pouvoir la faire pivoter seule pendant l'idle) */}
      <group ref={headRef} position={[0, 0.25, 0]}>
        <RoundedBox args={[0.1, 0.1, 0.1]} radius={0.022} smoothness={3} castShadow>
          <meshStandardMaterial color={skinColor} flatShading={true} />
        </RoundedBox>
        {/* Petite touffe de cheveux */}
        <mesh position={[0, 0.055, -0.005]} castShadow>
          <sphereGeometry args={[0.052, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
          <meshStandardMaterial color={hairColor} flatShading={true} />
        </mesh>
        {/* Yeux */}
        <mesh position={[-0.025, 0.005, -0.05]}>
          <sphereGeometry args={[0.009, 6, 6]} />
          <meshStandardMaterial color="#2b2b2b" />
        </mesh>
        <mesh position={[0.025, 0.005, -0.05]}>
          <sphereGeometry args={[0.009, 6, 6]} />
          <meshStandardMaterial color="#2b2b2b" />
        </mesh>
      </group>

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

      {/* Petite lueur au pied du mât : lisible côté jour, et se détache
          agréablement sur le côté nuit une fois le soleil rotatif passé. */}
      <mesh position={[0, 0.01, 0]} raycast={() => null}>
        <sphereGeometry args={[0.02, 8, 8]} />
        <meshStandardMaterial color="#FDE68A" emissive="#FDE68A" emissiveIntensity={1.4} toneMapped={false} />
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

// Soleil qui tourne lentement autour du globe : fait apparaître un vrai
// cycle jour/nuit (le "terminateur" balaie la sphère). On l'accompagne d'un
// disque émissif (non tone-mappé) qui accroche le bloom, pour vraiment
// *voir* le soleil dans le ciel plutôt qu'une simple source de lumière invisible.
const RotatingSun = () => {
  const groupRef = useRef();
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.getElapsedTime() * 0.05; // vitesse du cycle (~2 min/tour)
    const dist = 16;
    groupRef.current.position.set(Math.cos(t) * dist, 5, Math.sin(t) * dist);
  });
  return (
    <group ref={groupRef}>
      <directionalLight intensity={1.7} castShadow />
      <mesh>
        <sphereGeometry args={[1.1, 24, 24]} />
        <meshBasicMaterial color="#FFF3D0" toneMapped={false} />
      </mesh>
    </group>
  );
};

// Halo bleuté supprimé à la demande (rendait le globe trop diffus). On garde
// juste RotatingSun ci-dessus pour le cycle jour/nuit.

// Ciel nébuleux généré à la volée (canvas) : dégradé spatial + quelques
// nébuleuses douces, plutôt qu'un fond noir uni. Combiné avec <Stars/> pour
// les points scintillants.
function useNebulaTexture() {
  return useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');

    const bg = ctx.createLinearGradient(0, 0, 0, canvas.height);
    bg.addColorStop(0, '#05030f');
    bg.addColorStop(0.5, '#0b0620');
    bg.addColorStop(1, '#05030f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const blobColors = ['#4c1d95', '#1e3a8a', '#7e22ce', '#0e7490', '#831843'];
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * canvas.width;
      const y = Math.random() * canvas.height;
      const r = 60 + Math.random() * 160;
      const color = blobColors[Math.floor(Math.random() * blobColors.length)];
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, color + '55');
      grad.addColorStop(1, color + '00');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Semis d'étoiles fines directement dans la texture, en complément de <Stars/>
    for (let i = 0; i < 500; i++) {
      const x = Math.random() * canvas.width;
      const y = Math.random() * canvas.height;
      const s = Math.random() * 1.4;
      ctx.fillStyle = `rgba(255,255,255,${0.3 + Math.random() * 0.6})`;
      ctx.fillRect(x, y, s, s);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }, []);
}

const NebulaSky = () => {
  const texture = useNebulaTexture();
  return (
    <mesh>
      <sphereGeometry args={[90, 32, 32]} />
      <meshBasicMaterial map={texture} side={THREE.BackSide} fog={false} />
    </mesh>
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
  // On flotte le label légèrement au-dessus du sol (le long de la normale à
  // la sphère). Sans ce décalage, l'ancre est exactement sur la surface du
  // pays et le raycast d'occlusion de <Html> se cognait contre le maillage
  // du pays lui-même à chaque frame, ce qui gardait le label invisible en
  // permanence — d'où le "on ne voit jamais le nom sur le globe".
  const labelPos = flag.position.clone().add(flag.position.clone().normalize().multiplyScalar(0.4));
  return (
    <Html position={labelPos} center distanceFactor={6} zIndexRange={[5, 0]}>
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


const Player = ({ countriesData, onWaterChange, onLocationChange, onPlantFlag, visitedFlags, cameraLocked, keybindings, reduceMotion, teleportTarget, headingRef }) => {
  const playerRef = useRef();
  const { camera, gl } = useThree();
  const { playFootstep, playOar, playFlagPlant, startWaterAmbient, stopWaterAmbient } = useSound();
  
  const legL = useRef();
  const legR = useRef();
  const armL = useRef();
  const armR = useRef();
  const bodyRef = useRef();
  const oarRef = useRef();

  const playerPos = useRef(new THREE.Vector3(0, 4.96, 0));
  const playerDir = useRef(new THREE.Vector3(0, 0, 1));
  const keys = useRef({ z: false, q: false, s: false, d: false, space: false });
  // Distance de la caméra par rapport au joueur, ajustable à la molette
  // (remplace OrbitControls, qui entrait en conflit avec la caméra suiveuse
  // et faisait revenir le zoom à sa valeur par défaut à chaque frame).
  const zoomFactor = useRef(1);
  const cameraLockedRef = useRef(cameraLocked);
  useEffect(() => { cameraLockedRef.current = cameraLocked; }, [cameraLocked]);

  // Téléportation (barre de recherche) : on saute directement le joueur à la
  // position demandée, avec un cadrage caméra immédiat (pas de lerp) pour
  // éviter un long "rattrapage" visuel après un saut de plusieurs milliers
  // de km d'un coup.
  useEffect(() => {
    if (!teleportTarget || !playerRef.current) return;
    const radius = 4.96;
    playerPos.current.copy(teleportTarget).normalize().multiplyScalar(radius);
    playerRef.current.position.copy(playerPos.current);
    const up = playerPos.current.clone().normalize();
    // Garde une direction de marche tangente valide (nord local par défaut).
    let north = new THREE.Vector3(0, 1, 0).sub(up.clone().multiplyScalar(up.y));
    if (north.lengthSq() < 1e-6) north.set(1, 0, 0);
    playerDir.current.copy(north.normalize());
    const targetLook = playerPos.current.clone().add(playerDir.current);
    const matrix = new THREE.Matrix4().lookAt(playerPos.current, targetLook, up);
    playerRef.current.quaternion.setFromRotationMatrix(matrix);

    const backwardDir = playerDir.current.clone().negate();
    const idealCameraPos = playerPos.current.clone()
      .add(backwardDir.multiplyScalar(2.8 * zoomFactor.current))
      .add(up.clone().multiplyScalar(5.0 * zoomFactor.current));
    camera.position.copy(idealCameraPos);
    camera.up.copy(up);
    camera.lookAt(playerPos.current);
  }, [teleportTarget]);

  const [isOnWater, setIsOnWater] = useState(false);
  const [showFlagInHand, setShowFlagInHand] = useState(false);
  const [transitionProgress, setTransitionProgress] = useState(1);

  // Ambiance d'eau : démarre/s'arrête avec l'état terre/eau réellement acté
  // (donc après le debounce anti-flapping des archipels, pas à chaque frame).
  useEffect(() => {
    if (isOnWater) startWaterAmbient(); else stopWaterAmbient();
  }, [isOnWater]);
  useEffect(() => () => stopWaterAmbient(), []);
  
  const isPlacingFlag = useRef(false);
  const plantAnimTime = useRef(0);
  const currentCountryRef = useRef(null);
  const prevWaterState = useRef(false);
  const transitionStartTime = useRef(-10);
  const pendingWaterState = useRef(null);
  const pendingSince = useRef(0);
  const WATER_STATE_DEBOUNCE = 0.22;
  const walkAnim = useRef({ bob: 0, lean: 0, tilt: 0 });

  // Pool de particules réutilisées pour l'éclaboussure terre/eau (quasi gratuit
  // en perf : pas de création/destruction de meshes en continu).
  const SPLASH_COUNT = 14;
  const splashMeshes = useRef([]);
  const splashData = useRef(
    Array.from({ length: SPLASH_COUNT }, () => ({
      life: 999, maxLife: 1, vel: new THREE.Vector3(), pos: new THREE.Vector3(),
    }))
  );

  const spawnSplash = (origin, normal) => {
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

  // Tête (pour l'animation "idle" de regard autour de soi)
  const headRef = useRef();
  const idleTimer = useRef(0);
  const idleBlend = useRef(0);
  const IDLE_LOOK_AFTER = 4;     // secondes avant que le perso regarde autour de lui
  const SCREENSAVER_AFTER = 22;  // secondes avant la rotation caméra "écran de veille"

  // Sillage derrière la chaloupe (mêmes particules que l'éclaboussure, mais
  // émises en continu pendant l'avancée sur l'eau plutôt qu'en une seule fois).
  const WAKE_COUNT = 10;
  const wakeMeshes = useRef([]);
  const wakeData = useRef(
    Array.from({ length: WAKE_COUNT }, () => ({ life: 999, maxLife: 1, vel: new THREE.Vector3(), pos: new THREE.Vector3() }))
  );
  const wakeIndex = useRef(0);
  const wakeSpawnTimer = useRef(0);
  const oarSoundTimer = useRef(0);
  const spawnWake = (origin, dir) => {
    const i = wakeIndex.current;
    wakeIndex.current = (i + 1) % WAKE_COUNT;
    const p = wakeData.current[i];
    p.pos.copy(origin);
    p.vel.copy(dir).multiplyScalar(-0.008);
    p.life = 0;
    p.maxLife = 0.7 + Math.random() * 0.3;
  };

  // Poussière sous les pieds en marchant sur terre.
  const DUST_COUNT = 10;
  const dustMeshes = useRef([]);
  const dustData = useRef(
    Array.from({ length: DUST_COUNT }, () => ({ life: 999, maxLife: 1, vel: new THREE.Vector3(), pos: new THREE.Vector3() }))
  );
  const dustIndex = useRef(0);
  const dustSpawnTimer = useRef(0);
  const spawnDust = (origin, normal) => {
    const i = dustIndex.current;
    dustIndex.current = (i + 1) % DUST_COUNT;
    const p = dustData.current[i];
    p.pos.copy(origin).addScaledVector(normal, 0.01);
    p.vel.copy(normal).multiplyScalar(0.004);
    p.life = 0;
    p.maxLife = 0.45 + Math.random() * 0.2;
  };

  // Confettis à la plantation d'un drapeau.
  const CONFETTI_COUNT = 18;
  const CONFETTI_COLORS = ['#F87171', '#FBBF24', '#34D399', '#60A5FA', '#A78BFA', '#F472B6'];
  const confettiMeshes = useRef([]);
  const confettiData = useRef(
    Array.from({ length: CONFETTI_COUNT }, () => ({
      life: 999, maxLife: 1, vel: new THREE.Vector3(), pos: new THREE.Vector3(),
      normal: new THREE.Vector3(), spin: new THREE.Vector3(), color: new THREE.Color(),
    }))
  );
  const spawnConfetti = (origin, normal) => {
    let helper = new THREE.Vector3(0, 1, 0);
    if (Math.abs(normal.dot(helper)) > 0.9) helper = new THREE.Vector3(1, 0, 0);
    const t1 = new THREE.Vector3().crossVectors(normal, helper).normalize();
    const t2 = new THREE.Vector3().crossVectors(normal, t1).normalize();
    confettiData.current.forEach((p) => {
      const angle = Math.random() * Math.PI * 2;
      const outward = 0.02 + Math.random() * 0.05;
      const up = 0.07 + Math.random() * 0.08;
      p.vel
        .copy(t1).multiplyScalar(Math.cos(angle) * outward)
        .addScaledVector(t2, Math.sin(angle) * outward)
        .addScaledVector(normal, up);
      p.pos.copy(origin).addScaledVector(normal, 0.06);
      p.normal.copy(normal);
      p.spin.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12);
      p.color.set(CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]);
      p.life = 0;
      p.maxLife = 0.8 + Math.random() * 0.5;
    });
  };

  useEffect(() => {
    const kb = keybindings || DEFAULT_KEYBINDINGS;
    const handleKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === kb.forward || e.key === 'ArrowUp') keys.current.z = true;
      if (k === kb.left || e.key === 'ArrowLeft') keys.current.q = true;
      if (k === kb.backward || e.key === 'ArrowDown') keys.current.s = true;
      if (k === kb.right || e.key === 'ArrowRight') keys.current.d = true;
      if (k === kb.plant.toLowerCase() || e.code === 'Space') keys.current.space = true;
    };

    const handleKeyUp = (e) => {
      const k = e.key.toLowerCase();
      if (k === kb.forward || e.key === 'ArrowUp') keys.current.z = false;
      if (k === kb.left || e.key === 'ArrowLeft') keys.current.q = false;
      if (k === kb.backward || e.key === 'ArrowDown') keys.current.s = false;
      if (k === kb.right || e.key === 'ArrowRight') keys.current.d = false;
      if (k === kb.plant.toLowerCase() || e.code === 'Space') keys.current.space = false;
    };

    const handleWheel = (e) => {
      if (cameraLockedRef.current) return; // pas de zoom manuel pendant le zoom sur un pays
      e.preventDefault();
      zoomFactor.current = THREE.MathUtils.clamp(zoomFactor.current + e.deltaY * 0.001, 0.5, 2.2);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    const canvasEl = gl.domElement;
    canvasEl.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      canvasEl.removeEventListener('wheel', handleWheel);
    };
  }, [gl, keybindings]);

  useFrame(({ clock }, delta) => {
    if (!playerRef.current) return;
    if (cameraLocked) return; // le joueur est figé pendant qu'on consulte un pays

    let isMoving = false;
    const radius = 4.96;

    // Minuteur d'inactivité : recalculé en tout début de frame car il ne
    // dépend que de l'état courant des touches, pas du reste du mouvement.
    const isWalkingKey = keys.current.z || keys.current.s;
    const isTurningKey = !isWalkingKey && (keys.current.q || keys.current.d);
    if (isWalkingKey || isTurningKey || isPlacingFlag.current) {
      idleTimer.current = 0;
    } else {
      idleTimer.current += delta;
    }
    idleBlend.current = THREE.MathUtils.lerp(idleBlend.current, (idleTimer.current > IDLE_LOOK_AFTER && !reduceMotion) ? 1 : 0, 0.04);
    if (headRef.current) {
      headRef.current.rotation.y = Math.sin(clock.getElapsedTime() * 0.4) * 0.4 * idleBlend.current;
    }

    {
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
          spawnConfetti(playerPos.current, playerPos.current.clone().normalize());
          playFlagPlant();
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
          spawnSplash(playerPos.current, upNormal);
        }
      } else {
        pendingWaterState.current = null;
      }
      const waterState = prevWaterState.current;

      const tTrans = nowT - transitionStartTime.current;
      const progress = Math.min(1, tTrans / 0.6);
      setTransitionProgress(progress);

      setIsOnWater(waterState);
      if (onWaterChange) onWaterChange(waterState);
      if (onLocationChange) onLocationChange(currentCountry);

      // Cap de la boussole : écrit directement dans une ref mutable (pas de
      // setState ici). Avant, `onHeadingChange` appelait un setState à
      // *chaque frame* pendant tout mouvement, ce qui re-rendait tout
      // TravelPortfolioScene (panneaux, listes, etc.) 60x/seconde — c'était
      // la vraie cause du ralentissement, pas la boussole en elle-même.
      if (headingRef) {
        let north = new THREE.Vector3(0, 1, 0).sub(upNormal.clone().multiplyScalar(upNormal.y));
        if (north.lengthSq() < 1e-6) north.set(1, 0, 0);
        north.normalize();
        const east = new THREE.Vector3().crossVectors(north, upNormal).normalize();
        const heading = (Math.atan2(playerDir.current.dot(east), playerDir.current.dot(north)) * 180 / Math.PI + 360) % 360;
        headingRef.current = heading;
      }

      const backwardDir = playerDir.current.clone().negate();
      const idealCameraPos = playerPos.current.clone()
        .add(backwardDir.multiplyScalar(2.8 * zoomFactor.current))
        .add(upNormal.multiplyScalar(5.0 * zoomFactor.current));

      if (!cameraLocked) {
        if (idleTimer.current > SCREENSAVER_AFTER && !reduceMotion) {
          // Personne n'a touché aux commandes depuis un moment : la caméra
          // se met à orbiter doucement autour du globe, façon écran de veille.
          const orbitT = clock.getElapsedTime() * 0.06;
          const orbitDist = 13;
          const orbitPos = new THREE.Vector3(
            Math.cos(orbitT) * orbitDist,
            3 + Math.sin(orbitT * 0.4) * 2,
            Math.sin(orbitT) * orbitDist
          );
          camera.position.lerp(orbitPos, 0.02);
          camera.up.lerp(new THREE.Vector3(0, 1, 0), 0.02);
          camera.lookAt(0, 0, 0);
        } else {
          camera.position.lerp(idealCameraPos, 0.15);
          camera.up.copy(upNormal);
          const camLookMatrix = new THREE.Matrix4().lookAt(camera.position, playerPos.current, upNormal);
          const camTargetQuat = new THREE.Quaternion().setFromRotationMatrix(camLookMatrix);
          camera.quaternion.slerp(camTargetQuat, 0.18);
        }
      }
    }

    if (isMoving && !isPlacingFlag.current) {
      const t = clock.getElapsedTime() * 12; 
      const angle = 0.5; 
      if (!isOnWater) {
        if (isWalkingKey) {
          // Marche avant/arrière : foulée complète, bras et jambes en opposition.
          if (legL.current) legL.current.rotation.x = Math.sin(t) * angle;
          if (legR.current) legR.current.rotation.x = Math.sin(t + Math.PI) * angle;
          if (armL.current) armL.current.rotation.x = Math.sin(t + Math.PI) * angle;
          if (armR.current) armR.current.rotation.x = Math.sin(t) * angle;
          walkAnim.current.bob = Math.abs(Math.sin(t)) * 0.018;
          walkAnim.current.lean = THREE.MathUtils.lerp(walkAnim.current.lean, -0.07, 0.15);
          walkAnim.current.tilt = THREE.MathUtils.lerp(walkAnim.current.tilt, 0, 0.15);

          // Poussière sous les pieds, cadencée sur la foulée (un nuage à
          // chaque appui au sol, donc deux fois par cycle de jambe).
          dustSpawnTimer.current -= delta;
          if (dustSpawnTimer.current <= 0) {
            dustSpawnTimer.current = 0.16;
            spawnDust(playerPos.current, playerPos.current.clone().normalize());
            playFootstep();
          }
        } else if (isTurningKey) {
          // Rotation sur soi (Q/D seuls, sans avancer) : un pas chassé sur
          // place plutôt qu'une vraie foulée — jambes qui se soulèvent
          // légèrement en alternance, bras presque immobiles, et un léger
          // dévers du buste dans le sens du pivot pour vendre le mouvement.
          const tt = clock.getElapsedTime() * 8;
          const turnSign = keys.current.q ? 1 : -1;
          if (legL.current) legL.current.rotation.x = Math.sin(tt) * 0.22;
          if (legR.current) legR.current.rotation.x = Math.sin(tt + Math.PI) * 0.22;
          if (armL.current) armL.current.rotation.x = THREE.MathUtils.lerp(armL.current.rotation.x, 0, 0.2);
          if (armR.current) armR.current.rotation.x = THREE.MathUtils.lerp(armR.current.rotation.x, 0, 0.2);
          walkAnim.current.bob = Math.abs(Math.sin(tt)) * 0.01;
          walkAnim.current.lean = THREE.MathUtils.lerp(walkAnim.current.lean, 0, 0.15);
          walkAnim.current.tilt = THREE.MathUtils.lerp(walkAnim.current.tilt, turnSign * 0.09, 0.15);
        }
      } else {
        if (oarRef.current) oarRef.current.rotation.z = Math.sin(t) * 0.4;

        // Sillage derrière la chaloupe, uniquement en avançant/reculant sur l'eau.
        if (isWalkingKey) {
          wakeSpawnTimer.current -= delta;
          if (wakeSpawnTimer.current <= 0) {
            wakeSpawnTimer.current = 0.09;
            spawnWake(playerPos.current, playerDir.current);
          }
          // Le son suit la cadence d'un vrai coup de rame (~1.5x/s), pas
          // celle des particules de sillage (trop rapide -> crépitement).
          oarSoundTimer.current -= delta;
          if (oarSoundTimer.current <= 0) {
            oarSoundTimer.current = 0.65;
            playOar();
          }
        }
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
      walkAnim.current.tilt = THREE.MathUtils.lerp(walkAnim.current.tilt, 0, 0.15);
    }

    // Anime le pool de particules d'éclaboussure (mouvement + amortissement + fondu).
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
        mesh.scale.setScalar(THREE.MathUtils.lerp(1, 0.15, lifeT));
        if (mesh.material) mesh.material.opacity = 1 - lifeT;
      } else if (mesh.visible) {
        mesh.visible = false;
      }
    });

    // Sillage : s'étire et s'estompe derrière la chaloupe.
    wakeData.current.forEach((p, i) => {
      const mesh = wakeMeshes.current[i];
      if (!mesh) return;
      if (p.life < p.maxLife) {
        p.life += delta;
        p.pos.addScaledVector(p.vel, delta * 60);
        const lifeT = p.life / p.maxLife;
        mesh.visible = true;
        mesh.position.copy(p.pos);
        mesh.scale.setScalar(THREE.MathUtils.lerp(0.6, 1.8, lifeT));
        if (mesh.material) mesh.material.opacity = 0.5 * (1 - lifeT);
      } else if (mesh.visible) {
        mesh.visible = false;
      }
    });

    // Poussière : petit nuage qui monte doucement puis se dissipe.
    dustData.current.forEach((p, i) => {
      const mesh = dustMeshes.current[i];
      if (!mesh) return;
      if (p.life < p.maxLife) {
        p.life += delta;
        p.pos.addScaledVector(p.vel, delta * 60);
        const lifeT = p.life / p.maxLife;
        mesh.visible = true;
        mesh.position.copy(p.pos);
        mesh.scale.setScalar(THREE.MathUtils.lerp(0.5, 1.3, lifeT));
        if (mesh.material) mesh.material.opacity = 0.45 * (1 - lifeT);
      } else if (mesh.visible) {
        mesh.visible = false;
      }
    });

    // Confettis : gravité légère + rotation, puis fondu.
    confettiData.current.forEach((p, i) => {
      const mesh = confettiMeshes.current[i];
      if (!mesh) return;
      if (p.life < p.maxLife) {
        p.life += delta;
        p.vel.addScaledVector(p.normal, -0.0025); // gravité vers le sol du pays
        p.pos.addScaledVector(p.vel, delta * 60);
        const lifeT = p.life / p.maxLife;
        mesh.visible = true;
        mesh.position.copy(p.pos);
        mesh.rotation.x += p.spin.x * delta;
        mesh.rotation.y += p.spin.y * delta;
        mesh.rotation.z += p.spin.z * delta;
        if (mesh.material) {
          mesh.material.opacity = 1 - lifeT;
          if (lifeT < delta * 2) mesh.material.color.copy(p.color); // vient de spawner : fixe sa couleur
        }
      } else if (mesh.visible) {
        mesh.visible = false;
      }
    });
  });

  return (
    <>
      <group ref={playerRef} position={[0, 4.96, 0]}>
        {isOnWater ? (
          <BoatWithRider oarRef={oarRef} transitionProgress={transitionProgress} />
        ) : (
          <Stickman
            legL={legL}
            legR={legR}
            armL={armL}
            armR={armR}
            bodyRef={bodyRef}
            headRef={headRef}
            showFlagInHand={showFlagInHand}
            transitionProgress={transitionProgress}
            walkBob={walkAnim.current.bob}
            walkLean={walkAnim.current.lean}
            walkTilt={walkAnim.current.tilt}
          />
        )}
      </group>
      <SplashParticles meshesRef={splashMeshes} count={SPLASH_COUNT} />
      <WakeParticles meshesRef={wakeMeshes} count={WAKE_COUNT} />
      <DustParticles meshesRef={dustMeshes} count={DUST_COUNT} />
      <ConfettiParticles meshesRef={confettiMeshes} count={CONFETTI_COUNT} />
    </>
  );
};

// Rendu du pool de particules d'éclaboussure : reste en coordonnées MONDE
// (pas d'attache au joueur), sinon les particules hériteraient de sa
// rotation et partiraient dans le mauvais sens.
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

// Sillage de la chaloupe : petites taches claires, plus douces et plus
// étirées que l'éclaboussure (voir la boucle d'animation dans Player).
const WakeParticles = ({ meshesRef, count }) => (
  <group>
    {Array.from({ length: count }).map((_, i) => (
      <mesh key={i} ref={(el) => { if (el) meshesRef.current[i] = el; }} visible={false}>
        <circleGeometry args={[0.05, 8]} />
        <meshBasicMaterial color="#E0F2FE" transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    ))}
  </group>
);

// Poussière sous les pieds sur terre : petites sphères ternes, plus grosses
// et plus lentes que l'éclaboussure d'eau.
const DustParticles = ({ meshesRef, count }) => (
  <group>
    {Array.from({ length: count }).map((_, i) => (
      <mesh key={i} ref={(el) => { if (el) meshesRef.current[i] = el; }} visible={false}>
        <sphereGeometry args={[0.025, 6, 6]} />
        <meshBasicMaterial color="#C7B299" transparent opacity={0} depthWrite={false} />
      </mesh>
    ))}
  </group>
);

// Confettis à la plantation d'un drapeau : petits carrés colorés qui
// culbutent (rotation appliquée dans la boucle d'animation de Player).
const ConfettiParticles = ({ meshesRef, count }) => (
  <group>
    {Array.from({ length: count }).map((_, i) => (
      <mesh key={i} ref={(el) => { if (el) meshesRef.current[i] = el; }} visible={false}>
        <planeGeometry args={[0.035, 0.035]} />
        <meshBasicMaterial color="#F87171" transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    ))}
  </group>
);

// 6. Un Pays Individuel
// Construit les géométries (mesh extrudé + ligne de bordure) d'un pays à
// partir de ses coordonnées brutes. C'est le calcul coûteux (densification +
// triangulation earcut + subdivision anti-"sous le niveau de la mer" +
// projection sphérique) — voir idbGetGeometry/idbSetGeometry pour la mise en cache.
function buildCountryGeometryParts(feature) {
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

    const extrudeSettings = { depth: 0.2, bevelEnabled: false };
    let meshGeom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    meshGeom = subdivideFlatGeometry(meshGeom, 2.2);
    projectGeometryToSphere(meshGeom, 4.75);

    const borderPoints = [];
    outerRing.forEach(([lon, lat]) => {
      const r = 4.952;
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
}

// Sérialise les géométries calculées en tableaux Float32Array bruts
// (stockables tels quels dans IndexedDB), et inversement les reconstruit en
// vraies THREE.BufferGeometry sans repasser par tout le calcul.
function geometryPartsToCache(parts) {
  return parts.map(({ meshGeom, lineGeom }) => ({
    meshPositions: meshGeom.attributes.position.array,
    borderPositions: lineGeom.attributes.position.array,
  }));
}

function geometryPartsFromCache(cached) {
  return cached.map(({ meshPositions, borderPositions }) => {
    const meshGeom = new THREE.BufferGeometry();
    meshGeom.setAttribute('position', new THREE.BufferAttribute(meshPositions, 3));
    meshGeom.computeVertexNormals();
    meshGeom.computeBoundingSphere();
    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute('position', new THREE.BufferAttribute(borderPositions, 3));
    return { meshGeom, lineGeom };
  });
}

const CountryMesh = ({ feature, onHover, onClick, activeCountry }) => {
  const [hovered, setHovered] = useState(false);
  const [geometries, setGeometries] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const countryId = feature.id || feature.properties.name;

    idbGetGeometry(countryId).then((cached) => {
      if (cancelled) return;
      if (cached) {
        // Cache trouvé : reconstruction quasi instantanée, on saute tout le
        // calcul de subdivision/triangulation.
        setGeometries(geometryPartsFromCache(cached));
        return;
      }
      // Pas de cache : calcul normal (identique à avant), puis on sauvegarde
      // le résultat pour que le prochain chargement soit instantané.
      const parts = buildCountryGeometryParts(feature);
      setGeometries(parts);
      idbSetGeometry(countryId, geometryPartsToCache(parts));
    });

    return () => { cancelled = true; };
  }, [feature]);

  const countryName = feature.properties.name || 'Pays inconnu';
  const isHighlighted = hovered || countryName === activeCountry;
  const displayColor = isHighlighted ? (countryColorsData[countryName] || '#FACC15') : '#4ADE80';

  if (!geometries) return null;

  return (
    <group
      onPointerEnter={(e) => { e.stopPropagation(); setHovered(true); onHover(countryName); }}
      onPointerLeave={(e) => { e.stopPropagation(); setHovered(false); onHover(null); }}
      onClick={(e) => { e.stopPropagation(); onClick(countryName); }}
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
const GlobeWithCountries = ({ onHoverCountry, onClickCountry, setCountriesData, activeCountry }) => {
  const [countries, setCountries] = useState([]);

  useEffect(() => {
    let cancelled = false;
    fetchGeoJSONInWorker('https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json')
      .then((data) => {
        if (cancelled) return;
        setCountries(data.features);
        if (setCountriesData) setCountriesData(data.features);
      })
      .catch((err) => console.error('Erreur GeoJSON:', err));
    return () => { cancelled = true; };
  }, [setCountriesData]);

  return (
    <group>
      <mesh receiveShadow castShadow>
        <icosahedronGeometry args={[4.85, 12]} />
        {/* MeshDistortMaterial anime une déformation subtile en continu : donne
            une impression d'océan "vivant" sans coût de simulation physique.
            roughness/metalness ajustés pour des reflets francs qui accrochent
            le bloom (voir <Bloom/> plus bas) — effet d'eau scintillante. */}
        <MeshDistortMaterial
          color="#1E40AF"
          flatShading={true}
          roughness={0.42}
          metalness={0.2}
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
          activeCountry={activeCountry}
        />
      ))}
    </group>
  );
};

// 8. Composant Principal
const SettingsButton = ({ onClick }) => (
  <button
    onClick={onClick}
    title="Paramètres"
    style={{
      position: 'absolute', bottom: 30, right: 30, zIndex: 10, width: 46, height: 46,
      borderRadius: '50%', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(15,23,42,0.85)',
      color: '#fff', fontSize: 20, cursor: 'pointer', backdropFilter: 'blur(10px)',
      boxShadow: '0 10px 15px -3px rgba(0,0,0,0.3)',
    }}
  >
    ⚙️
  </button>
);

const StatsButton = ({ onClick }) => (
  <button
    onClick={onClick}
    title="Statistiques"
    style={{
      position: 'absolute', bottom: 30, right: 86, zIndex: 10, width: 46, height: 46,
      borderRadius: '50%', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(15,23,42,0.85)',
      color: '#fff', fontSize: 20, cursor: 'pointer', backdropFilter: 'blur(10px)',
      boxShadow: '0 10px 15px -3px rgba(0,0,0,0.3)',
    }}
  >
    📊
  </button>
);

const MuteButton = ({ muted, onClick }) => (
  <button
    onClick={onClick}
    title={muted ? 'Réactiver le son' : 'Couper le son'}
    style={{
      position: 'absolute', bottom: 30, right: 142, zIndex: 10, width: 46, height: 46,
      borderRadius: '50%', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(15,23,42,0.85)',
      color: '#fff', fontSize: 20, cursor: 'pointer', backdropFilter: 'blur(10px)',
      boxShadow: '0 10px 15px -3px rgba(0,0,0,0.3)',
    }}
  >
    {muted ? '🔇' : '🔊'}
  </button>
);

const SETTINGS_ACTIONS = [
  { key: 'forward', label: 'Avancer' },
  { key: 'backward', label: 'Reculer' },
  { key: 'left', label: 'Tourner à gauche' },
  { key: 'right', label: 'Tourner à droite' },
  { key: 'plant', label: 'Planter un drapeau' },
];

const SettingsPanel = ({ settings, setSettings, onClose, onExport, onImport, onReset }) => {
  const [listeningFor, setListeningFor] = useState(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  useEffect(() => {
    if (!listeningFor) return;
    const handler = (e) => {
      e.preventDefault();
      if (e.key === 'Escape') { setListeningFor(null); return; }
      const newKey = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'tab'].includes(newKey)) {
        setListeningFor(null);
        return;
      }
      setSettings((prev) => {
        const kb = { ...prev.keybindings };
        // Si cette touche est déjà utilisée par une autre action, on
        // échange les deux plutôt que de laisser deux actions sur la même
        // touche (évite les conflits silencieux).
        const conflictAction = Object.keys(kb).find((a) => a !== listeningFor && kb[a] === newKey);
        if (conflictAction) kb[conflictAction] = kb[listeningFor];
        kb[listeningFor] = newKey;
        return { ...prev, keybindings: kb };
      });
      setListeningFor(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [listeningFor, setSettings]);

  const update = (patch) => setSettings((prev) => ({ ...prev, ...patch }));

  const sectionTitle = { fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.6, margin: '0 0 10px 0' };
  const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', fontSize: 14 };

  return (
    <div
      style={{
        position: 'absolute', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'panelFadeIn 0.2s ease-out',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420, maxWidth: '92vw', maxHeight: '85vh', overflowY: 'auto',
          background: 'rgba(15,23,42,0.97)', border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 16, padding: 24, color: '#fff', boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>⚙️ Paramètres</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>

        {/* Contrôles */}
        <div style={{ marginBottom: 24 }}>
          <p style={sectionTitle}>Contrôles</p>
          {SETTINGS_ACTIONS.map(({ key, label }) => (
            <div key={key} style={row}>
              <span>{label}</span>
              <button
                onClick={() => setListeningFor(key)}
                style={{
                  minWidth: 64, padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                  border: listeningFor === key ? '1px solid #4ADE80' : '1px solid rgba(255,255,255,0.2)',
                  background: listeningFor === key ? 'rgba(74,222,128,0.15)' : 'rgba(255,255,255,0.06)',
                  color: '#fff', fontFamily: 'monospace', fontWeight: 'bold',
                }}
              >
                {listeningFor === key ? '...' : formatKeyLabel(settings.keybindings[key])}
              </button>
            </div>
          ))}
          <p style={{ fontSize: 11, opacity: 0.5, margin: '8px 0 0 0' }}>
            Les flèches directionnelles fonctionnent toujours en plus, quels que soient ces réglages.
            Cliquez sur une touche puis appuyez sur la nouvelle touche voulue (Échap pour annuler).
          </p>
        </div>

        {/* Graphismes */}
        <div style={{ marginBottom: 24 }}>
          <p style={sectionTitle}>Graphismes</p>
          <label style={row}>
            <span>Effet de lueur (bloom)</span>
            <input type="checkbox" checked={settings.bloom} onChange={(e) => update({ bloom: e.target.checked })} />
          </label>
          <label style={row}>
            <span>Ombres</span>
            <input type="checkbox" checked={settings.shadows} onChange={(e) => update({ shadows: e.target.checked })} />
          </label>
          <label style={row}>
            <span>Réduire les animations</span>
            <input type="checkbox" checked={settings.reduceMotion} onChange={(e) => update({ reduceMotion: e.target.checked })} />
          </label>
          <p style={{ fontSize: 11, opacity: 0.5, margin: '4px 0 0 0' }}>
            Désactive le regard "idle" et la rotation caméra en écran de veille.
          </p>
        </div>

        {/* Son */}
        <div style={{ marginBottom: 24 }}>
          <p style={sectionTitle}>Son</p>
          <label style={row}>
            <span>Couper le son</span>
            <input type="checkbox" checked={settings.soundMuted} onChange={(e) => update({ soundMuted: e.target.checked })} />
          </label>
          <div style={row}>
            <span>Volume général</span>
            <input
              type="range" min={0} max={1} step={0.05} value={settings.soundMaster}
              onChange={(e) => update({ soundMaster: parseFloat(e.target.value) })}
              disabled={settings.soundMuted}
              style={{ width: 120 }}
            />
          </div>
          <label style={row}>
            <span>Pas sur la terre</span>
            <input type="checkbox" checked={settings.soundFootsteps} onChange={(e) => update({ soundFootsteps: e.target.checked })} />
          </label>
          <label style={row}>
            <span>Sons de l'eau</span>
            <input type="checkbox" checked={settings.soundOars} onChange={(e) => update({ soundOars: e.target.checked })} />
          </label>
          <label style={row}>
            <span>Plantation de drapeau</span>
            <input type="checkbox" checked={settings.soundFlag} onChange={(e) => update({ soundFlag: e.target.checked })} />
          </label>
        </div>

        {/* Données */}
        <div>
          <p style={sectionTitle}>Données</p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button onClick={onExport} style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.06)', color: '#fff', cursor: 'pointer', fontSize: 13 }}>
              ⬇️ Exporter (JSON)
            </button>
            <label style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.06)', color: '#fff', cursor: 'pointer', fontSize: 13, textAlign: 'center' }}>
              ⬆️ Importer
              <input type="file" accept="application/json" onChange={onImport} style={{ display: 'none' }} />
            </label>
          </div>

          {!confirmingReset ? (
            <button
              onClick={() => setConfirmingReset(true)}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.12)', color: '#F87171', cursor: 'pointer', fontWeight: 'bold' }}
            >
              🗑️ Réinitialiser l'application
            </button>
          ) : (
            <div style={{ border: '1px solid rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.08)', borderRadius: 8, padding: 12 }}>
              <p style={{ margin: '0 0 10px 0', fontSize: 13 }}>
                ⚠️ Cette action supprime <strong>définitivement</strong> tous vos drapeaux, notes, notes sur 10 et photos. Pensez à exporter avant si besoin.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={async () => { await onReset(); setConfirmingReset(false); setResetDone(true); setTimeout(() => setResetDone(false), 2500); }}
                  style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: 'none', background: '#EF4444', color: '#fff', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  Oui, tout supprimer
                </button>
                <button
                  onClick={() => setConfirmingReset(false)}
                  style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: 'none', background: 'rgba(255,255,255,0.15)', color: '#fff', cursor: 'pointer' }}
                >
                  Annuler
                </button>
              </div>
            </div>
          )}
          {resetDone && <p style={{ fontSize: 12, color: '#4ADE80', margin: '8px 0 0 0' }}>✓ Application réinitialisée.</p>}
        </div>
      </div>
    </div>
  );
};

// --- Son (généré procéduralement, aucun fichier audio à charger) ---------
// Web Audio API pure : bruit filtré pour les pas/rames, deux notes courtes
// pour la plantation de drapeau, et un léger bruit filtré en boucle pour
// l'ambiance. Le contexte audio ne peut démarrer qu'après un geste
// utilisateur (politique des navigateurs), donc on l'initialise au premier
// clic/touche plutôt qu'au montage.
const SoundCtx = React.createContext(null);

function makeNoiseBuffer(actx, duration) {
  const bufferSize = Math.max(1, Math.floor(actx.sampleRate * duration));
  const buffer = actx.createBuffer(1, bufferSize, actx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

const SoundProvider = ({ settings, children }) => {
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const actxRef = useRef(null);
  const masterGainRef = useRef(null);
  const ambientGainRef = useRef(null);

  const effectiveMaster = () => (settingsRef.current.soundMuted ? 0 : settingsRef.current.soundMaster);

  const startAmbient = (actx, master) => {
    const src = actx.createBufferSource();
    src.buffer = makeNoiseBuffer(actx, 4);
    src.loop = true;
    const filter = actx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 450;
    const gain = actx.createGain();
    gain.gain.value = effectiveMaster() * 0.16;
    src.connect(filter).connect(gain).connect(master);
    src.start();
    ambientGainRef.current = gain;
  };

  const ensureContext = () => {
    if (!actxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      const actx = new Ctx();
      const master = actx.createGain();
      master.gain.value = effectiveMaster();
      master.connect(actx.destination);
      actxRef.current = actx;
      masterGainRef.current = master;
      startAmbient(actx, master);
    } else if (actxRef.current.state === 'suspended') {
      actxRef.current.resume();
    }
    return actxRef.current;
  };

  // Démarre (ou reprend) le contexte audio dès la première interaction.
  useEffect(() => {
    const resume = () => ensureContext();
    window.addEventListener('keydown', resume);
    window.addEventListener('pointerdown', resume);
    return () => {
      window.removeEventListener('keydown', resume);
      window.removeEventListener('pointerdown', resume);
    };
  }, []);

  // Répercute les changements de volume/mute en direct.
  useEffect(() => {
    if (masterGainRef.current) masterGainRef.current.gain.value = effectiveMaster();
    if (ambientGainRef.current) ambientGainRef.current.gain.value = effectiveMaster() * 0.16;
  }, [settings.soundMaster, settings.soundMuted]);

  const playFootstep = () => {
    if (!settingsRef.current.soundFootsteps) return;
    const actx = actxRef.current;
    if (!actx) return;
    const src = actx.createBufferSource();
    src.buffer = makeNoiseBuffer(actx, 0.07);
    const filter = actx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 650 + Math.random() * 200;
    const gain = actx.createGain();
    gain.gain.setValueAtTime(0.45, actx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.08);
    src.connect(filter).connect(gain).connect(masterGainRef.current);
    src.start();
  };

  const waterAmbientRef = useRef(null);

  const playOar = () => {
    if (!settingsRef.current.soundOars) return;
    const actx = actxRef.current;
    if (!actx) return;
    // Un vrai "plouf" d'eau : un bref pic net suivi d'un bruit passe-bande
    // qui descend (l'écume/les bulles), plutôt qu'un thud grave — c'est ce
    // thud qui sonnait comme un pas sur une planche de bois.
    const now = actx.currentTime;
    const duration = 0.4;
    const src = actx.createBufferSource();
    src.buffer = makeNoiseBuffer(actx, duration);
    const filter = actx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.9;
    filter.frequency.setValueAtTime(2400, now);
    filter.frequency.exponentialRampToValueAtTime(700, now + 0.32);
    const gain = actx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.17, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    src.connect(filter).connect(gain).connect(masterGainRef.current);
    src.start();
    src.stop(now + duration + 0.02);
  };

  // Ambiance d'eau continue tant qu'on est sur la mer (pas juste un bruit à
  // chaque coup de rame) : bruit filtré passe-bande dont la fréquence
  // "respire" via un LFO lent, pour un clapotis irrégulier plutôt qu'un son
  // figé. Démarrée/arrêtée depuis Player au changement d'état terre/eau.
  const startWaterAmbient = () => {
    if (!settingsRef.current.soundOars) return;
    const actx = ensureContext();
    if (!actx || waterAmbientRef.current) return;
    const src = actx.createBufferSource();
    src.buffer = makeNoiseBuffer(actx, 4);
    src.loop = true;
    const filter = actx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 700;
    filter.Q.value = 0.6;
    const lfo = actx.createOscillator();
    lfo.frequency.value = 0.18;
    const lfoGain = actx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    const gain = actx.createGain();
    gain.gain.setValueAtTime(0, actx.currentTime);
    gain.gain.linearRampToValueAtTime(0.09, actx.currentTime + 0.6);
    src.connect(filter).connect(gain).connect(masterGainRef.current);
    src.start();
    waterAmbientRef.current = { src, lfo, gain };
  };

  const stopWaterAmbient = () => {
    const nodes = waterAmbientRef.current;
    if (!nodes || !actxRef.current) return;
    const actx = actxRef.current;
    nodes.gain.gain.cancelScheduledValues(actx.currentTime);
    nodes.gain.gain.setValueAtTime(nodes.gain.gain.value, actx.currentTime);
    nodes.gain.gain.linearRampToValueAtTime(0, actx.currentTime + 0.4);
    waterAmbientRef.current = null;
    setTimeout(() => {
      try { nodes.src.stop(); nodes.lfo.stop(); } catch { /* déjà arrêté */ }
    }, 450);
  };

  // Coupe l'ambiance d'eau immédiatement si l'utilisateur désactive ce son
  // en cours de route, plutôt que d'attendre le prochain changement terre/eau.
  useEffect(() => {
    if (!settings.soundOars) stopWaterAmbient();
  }, [settings.soundOars]);

  const playFlagPlant = () => {
    if (!settingsRef.current.soundFlag) return;
    const actx = actxRef.current;
    if (!actx) return;
    [523.25, 659.25].forEach((freq, i) => {
      const osc = actx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const gain = actx.createGain();
      const start = actx.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.28, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      osc.connect(gain).connect(masterGainRef.current);
      osc.start(start);
      osc.stop(start + 0.32);
    });
  };

  return (
    <SoundCtx.Provider value={{ playFootstep, playOar, playFlagPlant, startWaterAmbient, stopWaterAmbient }}>
      {children}
    </SoundCtx.Provider>
  );
};

function useSound() {
  return useContext(SoundCtx) || { playFootstep: () => {}, playOar: () => {}, playFlagPlant: () => {}, startWaterAmbient: () => {}, stopWaterAmbient: () => {} };
}

// Convertit un cap en degrés (0 = Nord, sens horaire) en abréviation cardinale.
function headingToCardinal(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  return dirs[Math.round(deg / 45) % 8];
}

// Boussole : cadran SVG fixe (les points cardinaux ne bougent jamais) avec
// une aiguille qui pivote pour indiquer la direction actuellement pointée
// par le personnage. Cap validé numériquement (N=0°, E=90°, S=180°, O=270°).
//
// IMPORTANT côté perf : ce composant ne reçoit PAS le cap via une prop
// React qui changerait à chaque frame (ça forçait un re-render de toute
// l'appli 60x/seconde et faisait ramer tout le jeu). Il reçoit une *ref*
// mutable mise à jour en continu par Player, et anime lui-même l'aiguille
// via sa propre boucle requestAnimationFrame en modifiant directement les
// attributs du DOM — React n'est jamais sollicité pour ces mises à jour.
const Compass = ({ headingRef }) => {
  const needleRef = useRef(null);
  const labelRef = useRef(null);
  const lastDrawn = useRef(null);
  const CX = 50, CY = 50;

  useEffect(() => {
    let rafId;
    const tick = () => {
      const heading = headingRef?.current ?? 0;
      // On ne touche au DOM que si le cap a vraiment changé (évite un
      // travail de layout/paint inutile quand le joueur est immobile).
      if (lastDrawn.current === null || Math.abs(heading - lastDrawn.current) > 0.05) {
        lastDrawn.current = heading;
        if (needleRef.current) {
          needleRef.current.setAttribute('transform', `rotate(${heading} ${CX} ${CY})`);
        }
        if (labelRef.current) {
          labelRef.current.textContent = `${Math.round(heading).toString().padStart(3, '0')}° ${headingToCardinal(heading)}`;
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [headingRef]);

  const R = 42;
  const ticks = Array.from({ length: 12 }, (_, i) => i * 30);
  const cardinalLabels = [
    { deg: 0, text: 'N', color: '#4ADE80', size: 13 },
    { deg: 90, text: 'E', color: '#cbd5e1', size: 10 },
    { deg: 180, text: 'S', color: '#cbd5e1', size: 10 },
    { deg: 270, text: 'O', color: '#cbd5e1', size: 10 },
  ];
  const toXY = (deg, radius) => {
    const rad = ((deg - 90) * Math.PI) / 180; // 0° = haut du cadran
    return [CX + Math.cos(rad) * radius, CY + Math.sin(rad) * radius];
  };

  return (
    <div
      style={{
        position: 'absolute', top: '50%', left: 30, transform: 'translateY(-50%)', zIndex: 10,
        width: 108, background: 'linear-gradient(160deg, rgba(30,41,59,0.9), rgba(15,23,42,0.9))',
        border: '1px solid rgba(255,255,255,0.12)', borderRadius: 16,
        backdropFilter: 'blur(10px)', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)',
        padding: '10px 8px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', color: '#fff',
        pointerEvents: 'none',
      }}
    >
      <svg width="92" height="92" viewBox="0 0 100 100">
        <defs>
          <radialGradient id="compassFace" cx="50%" cy="42%" r="65%">
            <stop offset="0%" stopColor="#1e293b" />
            <stop offset="100%" stopColor="#0b1220" />
          </radialGradient>
          <filter id="needleShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="0.6" stdDeviation="0.8" floodColor="#000" floodOpacity="0.5" />
          </filter>
        </defs>

        <circle cx={CX} cy={CY} r={R} fill="url(#compassFace)" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" />
        <circle cx={CX} cy={CY} r={R - 5} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />

        {ticks.map((deg) => {
          const major = deg % 90 === 0;
          const [x1, y1] = toXY(deg, R - 2);
          const [x2, y2] = toXY(deg, major ? R - 9 : R - 6);
          return (
            <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={major ? 'rgba(74,222,128,0.7)' : 'rgba(255,255,255,0.25)'}
              strokeWidth={major ? 1.6 : 1} strokeLinecap="round" />
          );
        })}

        {cardinalLabels.map(({ deg, text, color, size }) => {
          const [x, y] = toXY(deg, R - 15);
          return (
            <text key={text} x={x} y={y + size * 0.35} textAnchor="middle"
              fontSize={size} fontWeight="bold" fill={color} fontFamily="system-ui, sans-serif">
              {text}
            </text>
          );
        })}

        {/* Aiguille à deux tons (rouge = nord, clair = sud) — la rotation est
            appliquée impérativement (voir useEffect ci-dessus), pas via une prop React. */}
        <g ref={needleRef} filter="url(#needleShadow)">
          <polygon points={`${CX},${CY - 27} ${CX - 4.5},${CY} ${CX},${CY - 5} ${CX + 4.5},${CY}`} fill="#EF4444" />
          <polygon points={`${CX},${CY + 20} ${CX - 4.5},${CY} ${CX},${CY + 5} ${CX + 4.5},${CY}`} fill="#cbd5e1" />
        </g>
        <circle cx={CX} cy={CY} r="4" fill="#f8fafc" stroke="#0b1220" strokeWidth="1.5" />
      </svg>

      <div ref={labelRef} style={{ fontSize: 12, fontWeight: 600, marginTop: 2, letterSpacing: 0.3 }}>
        000° N
      </div>
    </div>
  );
};

// Barre de recherche : tape le nom d'un pays, sélectionne une suggestion (ou
// Entrée si un seul résultat), le joueur y est téléporté directement.
const SearchBar = ({ countriesData, onSelect }) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const matches = query.trim().length > 0
    ? countriesData
        .filter((f) => (f.properties.name || '').toLowerCase().includes(query.trim().toLowerCase()))
        .slice(0, 8)
    : [];

  const select = (feature) => {
    onSelect(feature);
    setQuery(feature.properties.name);
    setOpen(false);
  };

  return (
    <div style={{ position: 'absolute', top: 30, left: '50%', transform: 'translateX(-50%)', zIndex: 20, width: 280 }}>
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches.length > 0) select(matches[0]);
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="🔍 Sauter à un pays..."
        style={{
          width: '100%', boxSizing: 'border-box', padding: '10px 14px', borderRadius: 10,
          border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(15,23,42,0.85)',
          color: '#fff', fontSize: 14, backdropFilter: 'blur(10px)', outline: 'none',
        }}
      />
      {open && matches.length > 0 && (
        <div style={{
          marginTop: 6, background: 'rgba(15,23,42,0.97)', border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 10, overflow: 'hidden', boxShadow: '0 10px 25px rgba(0,0,0,0.4)',
        }}>
          {matches.map((f) => (
            <div
              key={f.id || f.properties.name}
              onClick={() => select(f)}
              style={{ padding: '9px 14px', fontSize: 13, color: '#fff', cursor: 'pointer' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(74,222,128,0.15)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {f.properties.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const StatsPanel = ({ visitedFlags, countriesData, onClose, onShareCard, cardExporting }) => {
  const total = countriesData.length || 180;
  const pct = total ? Math.round((visitedFlags.length / total) * 100) : 0;

  const continentTotals = {};
  countriesData.forEach((f) => {
    const c = COUNTRY_CONTINENTS[f.properties.name] || 'Autre';
    continentTotals[c] = (continentTotals[c] || 0) + 1;
  });
  const continentVisited = {};
  visitedFlags.forEach((f) => {
    const c = COUNTRY_CONTINENTS[f.country] || 'Autre';
    continentVisited[c] = (continentVisited[c] || 0) + 1;
  });
  const continents = Object.keys(continentTotals).sort((a, b) => (continentVisited[b] || 0) - (continentVisited[a] || 0));

  const rated = [...visitedFlags].filter((f) => f.rating > 0).sort((a, b) => b.rating - a.rating);

  const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', fontSize: 14 };
  const sectionTitle = { fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.6, margin: '0 0 10px 0' };

  return (
    <div
      style={{ position: 'absolute', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'panelFadeIn 0.2s ease-out' }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 420, maxWidth: '92vw', maxHeight: '85vh', overflowY: 'auto', background: 'rgba(15,23,42,0.97)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 16, padding: 24, color: '#fff', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>📊 Statistiques</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 42, fontWeight: 800, color: '#4ADE80' }}>{pct}%</div>
          <div style={{ fontSize: 13, opacity: 0.7 }}>{visitedFlags.length} pays visités sur {total}</div>
        </div>

        <div style={{ marginBottom: 24 }}>
          <p style={sectionTitle}>Par continent</p>
          {continents.map((c) => {
            const v = continentVisited[c] || 0;
            const t = continentTotals[c];
            return (
              <div key={c} style={row}>
                <span>{c}</span>
                <span style={{ opacity: 0.8 }}>{v} / {t}</span>
              </div>
            );
          })}
        </div>

        <div style={{ marginBottom: 24 }}>
          <p style={sectionTitle}>Meilleurs pays notés</p>
          {rated.length === 0 && <p style={{ fontSize: 13, opacity: 0.5, margin: 0 }}>Aucune note pour le moment.</p>}
          {rated.slice(0, 5).map((f) => (
            <div key={f.country} style={row}>
              <span>{f.country}</span>
              <span style={{ color: '#FACC15' }}>⭐ {f.rating}/10</span>
            </div>
          ))}
        </div>

        <button
          onClick={onShareCard}
          disabled={cardExporting || visitedFlags.length === 0}
          style={{
            width: '100%', padding: '10px 12px', borderRadius: 8, border: 'none',
            background: visitedFlags.length === 0 ? 'rgba(255,255,255,0.1)' : '#4ADE80',
            color: visitedFlags.length === 0 ? 'rgba(255,255,255,0.4)' : '#000',
            fontWeight: 'bold', cursor: visitedFlags.length === 0 ? 'default' : 'pointer',
          }}
        >
          {cardExporting ? 'Génération...' : '📸 Partager ma carte de voyage'}
        </button>
      </div>
    </div>
  );
};

const TravelPortfolioScene = () => {
  const [hoveredCountry, setHoveredCountry] = useState(null);
  const [selectedCountry, setSelectedCountry] = useState(null);
  const [countriesData, setCountriesData] = useState([]);
  const [isOnWater, setIsOnWater] = useState(false);
  
  const [visitedFlags, setVisitedFlags] = useState([]);
  const [flagsLoaded, setFlagsLoaded] = useState(false);
  const [saveNotice, setSaveNotice] = useState(null); // null | 'saving' | 'saved' | 'error'
  const [activePopupFlag, setActivePopupFlag] = useState(null);
  const [returningCamera, setReturningCamera] = useState(false);

  // Contenu éditable du panneau (brouillon local tant qu'on n'a pas cliqué "Enregistrer")
  const [panelNotes, setPanelNotes] = useState('');
  const [panelRating, setPanelRating] = useState(0);
  const [panelPhotos, setPanelPhotos] = useState([]);

  // Fiche Wikipédia (photo de couverture + extrait) du pays affiché dans le panneau
  const [wikiInfo, setWikiInfo] = useState(null);
  const [wikiLoading, setWikiLoading] = useState(false);

  // Paramètres (touches, graphismes, son) + panneau associé
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);

  // Recherche / téléportation directe vers un pays
  const [teleportTarget, setTeleportTarget] = useState(null);
  const headingRef = useRef(0);

  // Statistiques et export de la carte de voyage
  const [showStats, setShowStats] = useState(false);
  const [cardExporting, setCardExporting] = useState(false);

  const cameraLocked = !!activePopupFlag || returningCamera;

  const jumpToCountry = (feature) => {
    const point = getCountryWalkPoint(feature);
    if (point) setTeleportTarget(point);
  };

  // Compose une image récap ("carte de voyage") à partir des pays visités,
  // et propose de la partager (Web Share API) ou de la télécharger sinon.
  const shareTravelCard = async () => {
    setCardExporting(true);
    try {
      const W = 1080, H = 1350;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');

      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#0b0620');
      bg.addColorStop(1, '#1e1140');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 54px system-ui, sans-serif';
      ctx.fillText('🌍 Mon carnet de voyage', W / 2, 110);

      const total = countriesData.length || 180;
      const pct = total ? Math.round((visitedFlags.length / total) * 100) : 0;
      ctx.font = '600 34px system-ui, sans-serif';
      ctx.fillStyle = '#4ADE80';
      ctx.fillText(`${visitedFlags.length} pays visités  •  ${pct}% du monde`, W / 2, 165);

      const rated = visitedFlags.filter((f) => f.rating > 0).sort((a, b) => b.rating - a.rating)[0];
      if (rated) {
        ctx.font = '28px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillText(`⭐ Coup de cœur : ${rated.country} (${rated.rating}/10)`, W / 2, 205);
      }

      // Mosaïque de quelques photos de voyage (si disponibles)
      const allPhotos = visitedFlags.flatMap((f) => f.photos || []).slice(0, 6);
      let y = 240;
      if (allPhotos.length > 0) {
        const cols = 3;
        const gap = 12;
        const cellW = (W - 80 - gap * (cols - 1)) / cols;
        const cellH = cellW * 0.75;
        const images = await Promise.all(allPhotos.map((src) => new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = src;
        })));
        images.forEach((img, i) => {
          if (!img) return;
          const col = i % cols;
          const row = Math.floor(i / cols);
          const x = 40 + col * (cellW + gap);
          const cy = y + row * (cellH + gap);
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(x, cy, cellW, cellH, 14);
          ctx.clip();
          // Recadrage centré façon object-fit: cover
          const scale = Math.max(cellW / img.width, cellH / img.height);
          const dw = img.width * scale, dh = img.height * scale;
          ctx.drawImage(img, x + (cellW - dw) / 2, cy + (cellH - dh) / 2, dw, dh);
          ctx.restore();
        });
        y += Math.ceil(allPhotos.length / cols) * (cellH + gap) + 30;
      }

      // Liste des pays visités (chips)
      ctx.font = '600 24px system-ui, sans-serif';
      ctx.textAlign = 'left';
      const names = visitedFlags.map((f) => f.country);
      const shown = names.slice(0, 30);
      let cx = 40, cy2 = y;
      const rowH = 46;
      shown.forEach((name) => {
        const w = ctx.measureText(name).width + 32;
        if (cx + w > W - 40) { cx = 40; cy2 += rowH; }
        if (cy2 > H - 120) return;
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.beginPath();
        ctx.roundRect(cx, cy2 - 30, w, 36, 18);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(name, cx + 16, cy2 - 6);
        cx += w + 10;
      });
      if (names.length > shown.length) {
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillText(`+ ${names.length - shown.length} autres`, cx + 4, cy2 - 6);
      }

      ctx.textAlign = 'center';
      ctx.font = '20px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText('Généré avec Countries Been', W / 2, H - 30);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const file = new File([blob], 'ma-carte-de-voyage.png', { type: 'image/png' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Mon carnet de voyage' });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ma-carte-de-voyage.png';
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') console.error('Erreur export carte de voyage :', err);
    } finally {
      setCardExporting(false);
    }
  };

  useEffect(() => { saveSettings(settings); }, [settings]);

  // Exporte les drapeaux/notes/photos actuels en fichier JSON téléchargeable
  // (sauvegarde manuelle, utile avant une réinitialisation par exemple).
  const exportData = () => {
    const serializable = visitedFlags.map((f) => ({ ...f, position: { x: f.position.x, y: f.position.y, z: f.position.z } }));
    const blob = new Blob([JSON.stringify(serializable, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `countries-been-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Importe un fichier JSON précédemment exporté (remplace les données actuelles).
  const importData = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed)) throw new Error('format invalide');
        setVisitedFlags(parsed.map((f) => ({ ...f, position: new THREE.Vector3(f.position.x, f.position.y, f.position.z) })));
      } catch (err) {
        alert("Ce fichier n'est pas un export valide de Countries Been.");
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // Réinitialise complètement l'application (drapeaux, notes, photos).
  const resetApp = async () => {
    await idbClearFlags();
    setVisitedFlags([]);
    setActivePopupFlag(null);
  };

  // Charge les drapeaux sauvegardés au tout premier montage.
  useEffect(() => {
    let cancelled = false;
    idbLoadFlags().then((saved) => {
      if (cancelled) return;
      if (saved && Array.isArray(saved)) {
        setVisitedFlags(saved.map((f) => ({ ...f, position: new THREE.Vector3(f.position.x, f.position.y, f.position.z) })));
      }
      setFlagsLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  // Sauvegarde automatique à chaque changement (nouveau drapeau, suppression,
  // note/photo/note enregistrée). On ignore le tout premier rendu (avant que
  // le chargement initial soit terminé) pour ne pas écraser la sauvegarde
  // existante avec un tableau vide au démarrage.
  useEffect(() => {
    if (!flagsLoaded) return;
    setSaveNotice('saving');
    idbSaveFlags(visitedFlags).then((ok) => {
      setSaveNotice(ok ? 'saved' : 'error');
      setTimeout(() => setSaveNotice(null), ok ? 1200 : 4000);
    });
  }, [visitedFlags, flagsLoaded]);

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
      
      {/* Panneau latéral des pays visités */}
      <div style={{ position: 'absolute', top: 30, right: 30, zIndex: 10, width: '220px', background: 'rgba(15, 23, 42, 0.85)', border: '1px solid rgba(255,255,255,0.15)', padding: '15px', borderRadius: '12px', backdropFilter: 'blur(10px)', color: '#fff' }}>
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

      <Canvas shadows={settings.shadows} camera={{ position: [0, 0, 14], fov: 45 }}>
        <SoundProvider settings={settings}>
          <ambientLight intensity={0.28} />
          <RotatingSun />
          <directionalLight position={[-10, -10, -5]} intensity={0.12} color="#90b0d0" />

          <NebulaSky />
          <Stars radius={85} depth={50} count={3000} factor={4} fade />
          
          <Player 
            countriesData={countriesData}
            onWaterChange={setIsOnWater}
            onLocationChange={(countryName) => setSelectedCountry(countryName)}
            onPlantFlag={handlePlantFlag}
            visitedFlags={visitedFlags}
            cameraLocked={cameraLocked}
            keybindings={settings.keybindings}
            reduceMotion={settings.reduceMotion}
            teleportTarget={teleportTarget}
            headingRef={headingRef}
          />

          <GlobeWithCountries 
            onHoverCountry={setHoveredCountry} 
            onClickCountry={(name) => {
              // Cliquer sur un pays déjà visité ouvre directement sa fiche.
              // Le déplacement se fait uniquement au clavier désormais.
              if (visitedFlags.some(f => f.country === name)) openCountryNote(name);
            }} 
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
          {settings.bloom && (
            <EffectComposer>
              <Bloom
                luminanceThreshold={0.35}
                luminanceSmoothing={0.9}
                intensity={0.9}
                mipmapBlur
              />
            </EffectComposer>
          )}
        </SoundProvider>
      </Canvas>

      <SearchBar countriesData={countriesData} onSelect={jumpToCountry} />
      <Compass headingRef={headingRef} />

      <StatsButton onClick={() => setShowStats(true)} />
      {showStats && (
        <StatsPanel
          visitedFlags={visitedFlags}
          countriesData={countriesData}
          onClose={() => setShowStats(false)}
          onShareCard={shareTravelCard}
          cardExporting={cardExporting}
        />
      )}

      <MuteButton muted={settings.soundMuted} onClick={() => setSettings((prev) => ({ ...prev, soundMuted: !prev.soundMuted }))} />
      <SettingsButton onClick={() => setShowSettings(true)} />
      {showSettings && (
        <SettingsPanel
          settings={settings}
          setSettings={setSettings}
          onClose={() => setShowSettings(false)}
          onExport={exportData}
          onImport={importData}
          onReset={resetApp}
        />
      )}

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
          {isOnWater ? '🌊 En navigation (Chaloupe)' : `🚶‍♂️ Territoire : ${selectedCountry || 'Inconnu'} ${visitedFlags.some(f => f.country === selectedCountry) ? '(Drapeau déjà posé)' : '(Appuyez sur ESPACE pour planter un drapeau)'}`}
        </p>
        {saveNotice && (
          <p style={{ margin: '6px 0 0 0', fontSize: 12, opacity: 0.7, color: saveNotice === 'error' ? '#F87171' : '#4ADE80' }}>
            {saveNotice === 'saving' && '💾 Sauvegarde...'}
            {saveNotice === 'saved' && '✓ Sauvegardé'}
            {saveNotice === 'error' && '⚠️ Échec de la sauvegarde (stockage plein ?)'}
          </p>
        )}
      </div>
    </div>
  );
};

export default TravelPortfolioScene;