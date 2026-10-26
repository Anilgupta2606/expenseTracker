/**
 * The Overview's hero in the new design: the month's income pours in as gold light and splits into a glass
 * jar each for spent, invested and saved. Each jar fills to its share (the fullest to 86%), each stream's
 * particles follow its amount, and the labels under the jars give the real figures.
 * Loaded on demand, so the classic design and a first paint never wait for three.js.
 */
import * as THREE from 'three';

export interface Jar { label: string; value: number; color: string }

let stop: (() => void) | null = null;
/** The running scene: kept across re-renders while the month's numbers stay the same, so the jars don't refill. */
let live: { sig: string; canvas: HTMLCanvasElement; labels: HTMLElement[] } | null = null;

export function mountJars(box: HTMLElement, source: number, jars: Jar[]): void {
  const sig = JSON.stringify([source, jars]);
  const fresh = box.querySelector('canvas')!;
  if (live && live.sig === sig && stop) {
    fresh.replaceWith(live.canvas);
    live.labels = [...box.querySelectorAll<HTMLElement>('[data-jar]')];
    return;
  }
  stop?.();
  const canvas = fresh;
  let R: THREE.WebGLRenderer;
  try { R = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch { box.classList.add('no3d'); return; }
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = matchMedia('(max-width: 900px)').matches;
  R.setPixelRatio(Math.min(devicePixelRatio, 2));
  // the app's palette: the source glows in its accent, the jars stand on its night colour
  const cssv = (n: string, f: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
  const GLOW = cssv('--nx-gold', '#f59e0b'), GLOW2 = cssv('--nx-gold-2', '#fcd34d'), NIGHT = cssv('--nx-night-2', '#2a2e38');
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  const world = new THREE.Group();
  scene.add(world);
  scene.add(new THREE.AmbientLight(new THREE.Color(NIGHT).lerp(new THREE.Color(0xffffff), 0.25), 1.4));
  const key = new THREE.PointLight(GLOW2, 40, 30, 1.5);
  key.position.set(0, 4, 3);
  scene.add(key);

  const n = jars.length, gap = 2.3;
  const X = jars.map((_, i) => (i - (n - 1) / 2) * gap);
  const H = 2.5, RAD = 0.72, BASE = -1.35;
  const total = Math.max(source, jars.reduce((a, j) => a + Math.max(0, j.value), 0), 1);
  const maxShare = Math.max(...jars.map((j) => Math.max(0, j.value) / total), 0.0001);

  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d')!, r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.3, 'rgba(255,255,255,.4)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const glow = (c: THREE.ColorRepresentation, s: number, o: number) => {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: c, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.scale.setScalar(s);
    return m;
  };

  // the source: a small gold sun of income
  const SRC = new THREE.Vector3(0, 2.75, 0);
  const src = new THREE.Mesh(new THREE.SphereGeometry(0.26, 32, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(GLOW2).lerp(new THREE.Color(0xffffff), 0.6) }));
  src.position.copy(SRC);
  world.add(src);
  const srcGlow = glow(GLOW, 2.4, 0.9);
  srcGlow.position.copy(SRC);
  world.add(srcGlow);

  // glass: a fresnel shell, bright at the edges like real glass
  const glassMat = (c: THREE.Color) => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, uniforms: { uC: { value: c } },
    vertexShader: 'varying vec3 n; varying vec3 v; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); n = normalize(normalMatrix * normal); v = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 uC; varying vec3 n; varying vec3 v; void main(){ float f = pow(1.0 - abs(dot(n, v)), 2.5); gl_FragColor = vec4(mix(vec3(.9,1.0,.95), uC, .5) * (f * .9 + .04), 1.0); }',
  });
  const J = jars.map((j, i) => {
    const color = new THREE.Color(j.color);
    const g = new THREE.Group();
    g.position.x = X[i];
    world.add(g);
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(RAD + 0.06, RAD + 0.06, H, 48, 1, true), glassMat(color));
    glass.position.y = BASE + H / 2;
    g.add(glass);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(RAD + 0.06, 0.025, 8, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = BASE + H;
    g.add(rim);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(RAD + 0.14, RAD + 0.2, 0.12, 48), new THREE.MeshStandardMaterial({ color: NIGHT, metalness: 0.6, roughness: 0.35 }));
    base.position.y = BASE - 0.06;
    g.add(base);
    const liquid = new THREE.Mesh(new THREE.CylinderGeometry(RAD, RAD, 1, 48), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, transparent: true, opacity: 0.88, roughness: 0.25, metalness: 0.1 }));
    g.add(liquid);
    const top = glow(color, 1.9, 0.55);
    g.add(top);
    const pool = glow(color, 3.4, 0.25);
    pool.position.y = BASE;
    g.add(pool);
    const share = Math.max(0, j.value) / total;
    const target = (share / maxShare) * 0.86 * H;
    return { liquid, top, target, level: calm ? target : 0.001, color, share };
  });

  // the streams: particles from the source, over an arc, down into each jar; more particles for more money
  const TOTAL = small ? 260 : 460;
  const pos: number[] = [], col: number[] = [], size: number[] = [];
  const meta: { i: number; t: number; sp: number; o: number }[] = [];
  J.forEach((j, i) => {
    const count = j.share > 0 ? Math.max(12, Math.round(TOTAL * j.share)) : 0;
    for (let k = 0; k < count; k++) {
      meta.push({ i, t: Math.random(), sp: 0.22 + Math.random() * 0.12, o: (Math.random() - 0.5) * 0.22 });
      pos.push(0, 0, 0); col.push(j.color.r, j.color.g, j.color.b); size.push(0.6 + Math.random() * 0.9);
    }
  });
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  pg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  pg.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
  const pts = new THREE.Points(pg, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true, uniforms: { uPR: { value: R.getPixelRatio() } },
    vertexShader: 'attribute float aSize; uniform float uPR; varying vec3 vc; void main(){ vc = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * uPR * 34.0 / -mv.z; }',
    fragmentShader: 'varying vec3 vc; void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, 0.0, d); gl_FragColor = vec4(mix(vec3(1.0,.9,.8), vc, .7) * a * a * 1.6, 1.0); }',
  }));
  pts.frustumCulled = false;
  world.add(pts);
  const curves = X.map((x) => new THREE.QuadraticBezierCurve3(SRC.clone(), new THREE.Vector3(x * 0.9, 2.9, 0.4), new THREE.Vector3(x, BASE + H + 0.25, 0)));

  // the pointer turns the jars a little; nothing is drawn while the hero is off screen
  let px = 0, py = 0, tx = 0, ty = 0, vis = true, alive = true;
  const onMove = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); tx = (e.clientX - r.left) / r.width - 0.5; ty = (e.clientY - r.top) / r.height - 0.5; };
  const onLeave = () => { tx = ty = 0; };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  const io = new IntersectionObserver((e) => { vis = e[0].isIntersecting; });
  io.observe(canvas);
  live = { sig, canvas, labels: [...box.querySelectorAll<HTMLElement>('[data-jar]')] };
  const me = live;
  const V = new THREE.Vector3();
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    R.setSize(w, h, false);
    cam.aspect = w / h;
    const spread = Math.max(1, (n * gap) / 6.9);
    cam.position.set(0, 0.9, (w / h < 1.1 ? 11.5 : 9.2) * spread);
    cam.lookAt(0, w / h < 1.6 ? 0.25 : 0.55, 0);   // narrow: the scene sits a little higher, clear of the labels
    cam.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();
  const clock = new THREE.Clock(), T0 = performance.now();
  const frame = () => {
    if (!alive) return;
    requestAnimationFrame(frame);
    if (!vis || !canvas.isConnected) return;
    const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime, since = (performance.now() - T0) / 1000;
    px += (tx - px) * 0.06; py += (ty - py) * 0.06;
    world.rotation.y = px * 0.5 + Math.sin(t * 0.25) * 0.06;
    world.rotation.x = py * 0.12;
    src.scale.setScalar(1 + Math.sin(t * 3) * 0.06);
    srcGlow.material.opacity = 0.75 + Math.sin(t * 3) * 0.15;
    const pa = pg.attributes.position as THREE.BufferAttribute, flowing = calm ? 1 : Math.min(1, since / 0.6);
    meta.forEach((m, k) => {
      m.t = (m.t + dt * m.sp * flowing) % 1;
      const j = J[m.i];
      if (m.t < 0.82) { curves[m.i].getPoint(m.t / 0.82, V); V.x += m.o * Math.sin(m.t * 9); V.z += m.o; }
      else { const d = (m.t - 0.82) / 0.18, top = BASE + Math.max(0.05, j.level); V.set(X[m.i] + m.o * 0.8, BASE + H + 0.25 - d * (BASE + H + 0.25 - top), m.o * 0.6); }
      pa.setXYZ(k, V.x, V.y, V.z);
    });
    pa.needsUpdate = true;
    J.forEach((j, i) => {
      j.level += (j.target - j.level) * (calm ? 1 : Math.min(1, dt * 1.6 * Math.min(1, Math.max(0, since - 0.4))));
      const h = Math.max(0.001, j.level) * (1 + Math.sin(t * 2.2 + i) * 0.006);
      j.liquid.scale.y = h;
      j.liquid.position.y = BASE + h / 2;
      j.top.position.y = BASE + h;
      j.top.material.opacity = j.share > 0 ? 0.45 + Math.sin(t * 2 + i) * 0.12 : 0;
      V.set(X[i], BASE - 0.25, 0).applyMatrix4(world.matrixWorld).project(cam);
      if (me.labels[i]) me.labels[i].style.left = `${(((V.x + 1) / 2) * 100).toFixed(2)}%`;
    });
    R.render(scene, cam);
  };
  requestAnimationFrame(frame);
  stop = () => {
    alive = false;
    io.disconnect();
    removeEventListener('resize', resize);
    R.dispose();
    live = null;
    pg.dispose();
    stop = null;
  };
}
