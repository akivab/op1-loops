"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { LoopEngine } from "@/lib/engine";
import { SR, type Loop } from "@/lib/types";
import { isSilenced, type Mix } from "./TrackLanes";

// Two reels with four filaments of tape — one per track, side by side across the
// tape's width. As the loop plays the filaments wind off the left reel, run over
// the head and pile up on the right one. On = track colour, off = grey,
// queued = pulsing.

const W = 300;
const H = 132;
const REEL_X = 1.55;
const PACK_MIN = 0.42;
const PACK_MAX = 0.95;
const STRAND_W = 0.16; // width of one filament (along the axle)
const STRAND_GAP = 0.04;
const HEAD_Y = -1.18;
const HEAD_X = 0.32;
const CAM_R = 6.8;
const CAM_Y = 1.9;
const CAM_AZ = Math.atan2(3.3, 5.0);
const TRACK_VARS = ["--t0", "--t1", "--t2", "--t3"];

interface Props {
  loop: Loop;
  engine: LoopEngine | null;
  mix: Mix;
  queued: boolean[];
}

export default function TapeReels3D({ loop, engine, mix, queued }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const live = useRef({ loop, engine, mix, queued });
  live.current = { loop, engine, mix, queued };

  useEffect(() => {
    const el = mount.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 50);
    camera.position.set(3.3, 1.9, 5.0);
    camera.lookAt(0.15, -0.3, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2, 3, 5);
    scene.add(key);

    const css = getComputedStyle(el);
    const trackColors = TRACK_VARS.map((v) => new THREE.Color(css.getPropertyValue(v).trim() || "#888"));
    const grey = new THREE.Color("#55534f");
    const zOf = (t: number) => (t - 1.5) * (STRAND_W + STRAND_GAP);
    const depth = 4 * (STRAND_W + STRAND_GAP);

    // Moving stripes along the tape so you can see it travel.
    const stripe = document.createElement("canvas");
    stripe.width = 64;
    stripe.height = 4;
    const sg = stripe.getContext("2d")!;
    sg.fillStyle = "#fff";
    sg.fillRect(0, 0, 64, 4);
    sg.fillStyle = "#b5b5b5";
    sg.fillRect(0, 0, 10, 4);
    const stripeTex = new THREE.CanvasTexture(stripe);
    stripeTex.wrapS = THREE.RepeatWrapping;
    stripeTex.repeat.set(8, 1);

    const strandMats = trackColors.map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.1, map: stripeTex, side: THREE.DoubleSide }),
    );
    const packMats = trackColors.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.15 }));
    const flangeMat = new THREE.MeshStandardMaterial({ color: 0xdedcd6, transparent: true, opacity: 0.16, roughness: 0.2, side: THREE.DoubleSide });
    const hubMat = new THREE.MeshStandardMaterial({ color: 0x1d1d1b, roughness: 0.6 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xc9c7c0, roughness: 0.3, metalness: 0.8 });

    const reels = [-REEL_X, REEL_X].map((x) => {
      const g = new THREE.Group();
      g.position.x = x;
      // flanges either side of the four filaments
      for (const z of [-depth / 2 - 0.03, depth / 2 + 0.03]) {
        const f = new THREE.Mesh(new THREE.CircleGeometry(PACK_MAX + 0.1, 48), flangeMat);
        f.position.z = z;
        g.add(f);
      }
      const spin = new THREE.Group();
      g.add(spin);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, depth + 0.08, 24), hubMat);
      hub.rotation.x = Math.PI / 2;
      spin.add(hub);
      for (let k = 0; k < 3; k++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, depth + 0.1), metal);
        spoke.position.set(Math.sin((k * 2 * Math.PI) / 3) * 0.14, Math.cos((k * 2 * Math.PI) / 3) * 0.14, 0);
        spoke.rotation.z = (-k * 2 * Math.PI) / 3;
        spin.add(spoke);
      }
      // one pack per filament, scaled each frame
      const packs = [0, 1, 2, 3].map((t) => {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, STRAND_W, 48, 1, true), packMats[t]);
        const cap = new THREE.Mesh(new THREE.RingGeometry(0.26, 1, 48), packMats[t]);
        m.rotation.x = Math.PI / 2;
        cap.position.z = STRAND_W / 2;
        const holder = new THREE.Group();
        holder.add(m, cap);
        holder.position.z = zOf(t);
        g.add(holder);
        return holder;
      });
      scene.add(g);
      return { g, spin, packs };
    });

    // head + guide rollers
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, depth + 0.12), metal);
    head.position.set(0, HEAD_Y - 0.1, 0);
    scene.add(head);
    for (const x of [-HEAD_X, HEAD_X]) {
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, depth + 0.14, 16), metal);
      r.rotation.x = Math.PI / 2;
      r.position.set(x, HEAD_Y, 0);
      scene.add(r);
    }

    // filaments: flat ribbons along left pack → roller → roller → right pack
    const SEG = 4;
    const strands = [0, 1, 2, 3].map((t) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SEG * 2 * 3), 3));
      const uv = new Float32Array(SEG * 2 * 2);
      geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      const idx: number[] = [];
      for (let i = 0; i < SEG - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, strandMats[t]);
      scene.add(mesh);
      return { geo, mesh };
    });

    let raf = 0;
    let angle = 0;
    let travel = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const { loop, engine, mix, queued } = live.current;
      const stem = loop.stem;
      const playing = !!engine?.playing;
      const frac =
        playing && stem
          ? Math.min(1, Math.max(0, (engine!.position() * SR - (loop.start - stem.start)) / (loop.end - loop.start)))
          : 0;
      // constant tape speed: the smaller pack spins faster
      const rL = Math.sqrt(PACK_MAX ** 2 - (PACK_MAX ** 2 - PACK_MIN ** 2) * frac);
      const rR = Math.sqrt(PACK_MIN ** 2 + (PACK_MAX ** 2 - PACK_MIN ** 2) * frac);
      if (playing) {
        angle += dt * 2.4;
        travel += dt * 0.9;
      }
      reels[0].spin.rotation.z = -angle * (PACK_MAX / rL);
      reels[1].spin.rotation.z = -angle * (PACK_MAX / rR);
      stripeTex.offset.x = -travel;

      const pulse = 0.5 + 0.5 * Math.sin(now / 90);
      for (let t = 0; t < 4; t++) {
        const on = !isSilenced(mix, t);
        const c = on ? trackColors[t] : grey;
        const glow = queued[t] ? pulse : 0;
        for (const m of [strandMats[t], packMats[t]]) {
          m.color.copy(c);
          m.emissive.copy(queued[t] ? trackColors[t] : c);
          m.emissiveIntensity = queued[t] ? 0.25 + 0.6 * glow : on ? 0.12 : 0;
        }
        reels[0].packs[t].scale.set(rL, rL, 1);
        reels[1].packs[t].scale.set(rR, rR, 1);

        const z = zOf(t);
        const pts: [number, number][] = [
          [-REEL_X, -rL],
          [-HEAD_X, HEAD_Y - 0.06],
          [HEAD_X, HEAD_Y - 0.06],
          [REEL_X, -rR],
        ];
        const pos = strands[t].geo.getAttribute("position") as THREE.BufferAttribute;
        const uv = strands[t].geo.getAttribute("uv") as THREE.BufferAttribute;
        let along = 0;
        pts.forEach(([x, y], i) => {
          if (i) along += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]);
          pos.setXYZ(i * 2, x, y, z - STRAND_W / 2);
          pos.setXYZ(i * 2 + 1, x, y, z + STRAND_W / 2);
          uv.setXY(i * 2, along / 4, 0);
          uv.setXY(i * 2 + 1, along / 4, 1);
        });
        pos.needsUpdate = true;
        uv.needsUpdate = true;
        strands[t].geo.computeVertexNormals();
      }
      // slow sway around the reels so you can see all four filaments and the tape run
      const az = CAM_AZ + 0.5 * Math.sin((now / 1000) * ((2 * Math.PI) / 24));
      camera.position.set(Math.sin(az) * CAM_R, CAM_Y, Math.cos(az) * CAM_R);
      camera.lookAt(0.0, -0.3, 0);
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      [...strandMats, ...packMats, flangeMat, hubMat, metal].forEach((m) => m.dispose());
      stripeTex.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div className="reels3d" ref={mount} style={{ width: W, height: H }} aria-hidden />;
}
