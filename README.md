# Wizard Duel — Motion Spellcasting Engine

A real-time, browser-based motion gesture spellcasting engine. The previous template-based `$1 Unistroke` recognizer has been completely replaced with a robust continuous motion-pattern recognition engine.

Draw spells in the air using your index finger without pausing! The system continuously evaluates motion segments to detect spell patterns securely.

## 🌟 Key Features

- **Continuous Casting (No pause-to-cast)** 
  Gestures are evaluated in real-time on a continuous rolling window. Fast, fluid casting allows you to string spells together without unnatural stops.
- **Directional & Curvature Segmentation** 
  Movements are decomposed into direction vectors (e.g., `UP`, `DOWN`, `LEFT`, `RIGHT`, `DIAG_UL`) and curves (`ARC_CW`, `ARC_CCW`). Motion is tracked dynamically by minimum length and turn limits.
- **Pose Detection**
  Includes a Protego Maxima implementation powered by static landmark recognition (detecting an open palm for >1 second) combined with velocity stabilization.
- **Combos & State Engine**
  Fully functional Wizard Duel `GameEngine`. Chain spells rapidly for combo multipliers. Battle an AI Dark Wizard who responds with spells of his own.
- **Micro-Animations & Dynamic Feedback**
  Polished "Dark Mystical" aesthetic, complete with spell flare bursts depending on the magic type, shield visualizers, cast cooldown tracking, and immersive AudioTone bursts per spell!

---

## 🧙‍♂️ The Spell Directory

The engine comes equipped with 10 distinctive spells spanning Attack, Defense, and Utility classifications.

### Attack Spells
* **Expelliarmus** (Disarm) — `RIGHT → DOWN`: A quick flick right and down.
* **Stupefy** (Stun) — `RIGHT → LEFT → RIGHT`: A lightning-bolt back-and-forth jab.
* **Sectumsempra** (Bleeding DoT) — `Fast diagonal slash`: Must be ripped quickly.
* **Bombarda** (Burst Damage) — `HORIZONTAL → VERTICAL`: Drawing an "L" or inverted "L".
* **Aguamenti** (Pushback) — `Smooth arc sweep`: > 80° sweep with a fluid, slow curvature.

### Defense Spells
* **Protego** (Shield) — `Long upward stroke`: Deliberate vertical shield raise.
* **Protego Maxima** (Ultimate Shield) — `Open palm (all fingers extended)`: Held steady and open to summon an impenetrable shield.

### Utility Spells
* **Lumos** (Light) — `Short fast upward flick`: High-velocity energy tap.
* **Nox** (Cancel) — `Short curved downward flick`: Snappy dismissive curve.
* **Petrificus Totalus** (Immobilise) — `Curve then straight line`: A curved gathering block, followed by an immediate thrust in any direction.

---

## 🧩 Architecture

The core logic is heavily modularized for game integration:

1. **`motionGesture.ts`** 
   The core recognition engine. Deconstructs raw spatial paths into `MotionSegment` elements (direction, curvature, velocity, angular displacement). Contains sequence matching confidence models.
2. **`spellRegistry.ts`** 
   A robust dictionary mapping `SpellId`s to `SpellDefinition` objects, complete with their pattern-detecting functions, colors, cooldowns, and status-effect properties.
3. **`gameEngine.ts`** 
   A turn-based and realtime hybrid duel state manager. Handles player vs. opponent health, damage absorption via shields, damage-over-time (Bleeding/DoT) ticks, CC timers (Stuns), and an AI automated opponent loop.
4. **`MotionRecognizer.ts`** (Component) 
   Sits between the camera `useHandTracking` hook and the `GameEngine`, acting as the bridge. Converts sliding 30-frame coordinate windows into detected spells and ensures debouncing protocols.
5. **`HandTracker.tsx`** & **`DuelArena` / `CanvasOverlay.tsx`** 
   Clean UI visualisers using Canvas2D for hardware-accelerated drawing, glowing trails, debug mode bounding box data, and React state rendering.

## 🚀 Getting Started

If you want to tweak parameters:
1. Open the UI and click the **Debug ON** button in the lower left to view real-time segments, generated direction identifiers, distance sizing and FPS metrics!
2. Open `motionGesture.ts` and modify `DEFAULT_MOTION_CONFIG` to tweak the turn threshold limits. 
3. Open `spellRegistry.ts` to add new gesture configurations safely.
