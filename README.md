# Wizard Duel

Wizard Duel is a browser game where you cast spells with hand gestures instead of buttons. Point your camera at your hand, draw the spell shape in the air, and battle in real time.

## Gameplay

There are two ways to play:

- Training mode lets you practice spells without an opponent.
- Duel mode lets you host or join a room and fight another player over WebRTC.

During a duel, the goal is simple: cast faster and more accurately than your opponent. Some spells attack, some defend, and some help you control the fight. Shields can block damage, and the stronger spells are usually worth saving for the right moment.

The spell set includes quick attacks like Expelliarmus and Stupefy, defensive spells like Protego and Protego Maxima, and utility spells like Lumos, Nox, and Petrificus Totalus. If you are new, start in Training mode and learn the motion for each spell before jumping into a match.

## How To Play

1. Open the app and allow camera access.
2. Go to Training mode to practice your casting.
3. Try the spell motions shown in the game until they are recognized reliably.
4. Create a duel room when you are ready to play against someone else.
5. Share the invite link or QR code with your opponent.
6. Enter the room as the host or join with the room code.

## Installation And Setup

### Prerequisites

- Node.js 20 or newer
- npm
- A browser with camera support

### Local Setup

1. Clone the repository.
2. Install dependencies:

  ```bash
  npm install
  ```

3. Start the development server:

  ```bash
  npm run dev
  ```

4. Open `http://localhost:3000` in your browser.
5. Allow camera access when prompted.

### Production Build

To test the production build locally:

```bash
npm run build
npm run start
```

## Multiplayer Setup

Multiplayer works locally without extra configuration. If you run the app on Vercel and want room links to persist reliably, add an Upstash Redis or Vercel KV integration and redeploy.

## Development Scripts

- `npm run dev` starts the app in development mode.
- `npm run build` creates a production build.
- `npm run start` runs the production build.
- `npm run lint` checks the code for lint issues.

## Tips

- Training mode is the best place to learn the gestures before a match.
- If a spell is not being recognized, try drawing it a little slower and with a cleaner shape.
- Use the lobby to create a room, copy the invite link, or scan the QR code to join quickly.

## Technical Overview

### Motion Spellcasting Engine

A real-time, browser-based motion gesture spellcasting engine. The previous template-based `$1 Unistroke` recognizer has been completely replaced with a robust continuous motion-pattern recognition engine.

Draw spells in the air using your index finger without pausing. The system continuously evaluates motion segments to detect spell patterns securely.

### Key Features

- **Continuous Casting (No pause-to-cast)**
  Gestures are evaluated in real time on a continuous rolling window. Fast, fluid casting allows you to string spells together without unnatural stops.
- **Directional & Curvature Segmentation**
  Movements are decomposed into direction vectors such as `UP`, `DOWN`, `LEFT`, `RIGHT`, `DIAG_UL` and curves such as `ARC_CW`, `ARC_CCW`. Motion is tracked dynamically by minimum length and turn limits.
- **Pose Detection**
  Includes a Protego Maxima implementation powered by static landmark recognition, detecting an open palm for more than 1 second, combined with velocity stabilization.
- **Combos & State Engine**
  Fully functional Wizard Duel game engine. Chain spells rapidly for combo multipliers. Battle an AI Dark Wizard who responds with spells of his own.
- **Micro-Animations & Dynamic Feedback**
  Polished dark mystical aesthetic, complete with spell flare bursts depending on the magic type, shield visualizers, cast cooldown tracking, and immersive audio tone bursts per spell.

---

### The Spell Directory

The engine comes equipped with 10 distinctive spells spanning Attack, Defense, and Utility classifications.

#### Attack Spells

- **Expelliarmus** (Disarm) — `RIGHT → DOWN`: A quick flick right and down.
- **Stupefy** (Stun) — `RIGHT → LEFT → RIGHT`: A lightning-bolt back-and-forth jab.
- **Sectumsempra** (Bleeding DoT) — `Fast diagonal slash`: Must be ripped quickly.
- **Bombarda** (Burst Damage) — `HORIZONTAL → VERTICAL`: Drawing an "L" or inverted "L".
- **Aguamenti** (Pushback) — `Smooth arc sweep`: More than 80° sweep with a fluid, slow curvature.

#### Defense Spells

- **Protego** (Shield) — `Long upward stroke`: Deliberate vertical shield raise.
- **Protego Maxima** (Ultimate Shield) — `Open palm (all fingers extended)`: Held steady and open to summon an impenetrable shield.

#### Utility Spells

- **Lumos** (Light) — `Short fast upward flick`: High-velocity energy tap.
- **Nox** (Cancel) — `Short curved downward flick`: Snappy dismissive curve.
- **Petrificus Totalus** (Immobilise) — `Curve then straight line`: A curved gathering block, followed by an immediate thrust in any direction.

---

### Architecture

The core logic is heavily modularized for game integration:

1. **motionGesture.ts**
   The core recognition engine. Deconstructs raw spatial paths into MotionSegment elements including direction, curvature, velocity, and angular displacement. Contains sequence matching confidence models.
2. **spellRegistry.ts**
   A dictionary mapping SpellIds to SpellDefinition objects, complete with pattern-detecting functions, colors, cooldowns, and status-effect properties.
3. **gameEngine.ts**
   A turn-based and real-time hybrid duel state manager. Handles player versus opponent health, damage absorption via shields, damage-over-time ticks, crowd control timers, and an AI automated opponent loop.
4. **MotionRecognizer.ts**
   Sits between the camera useHandTracking hook and the game engine, acting as the bridge. Converts sliding 30-frame coordinate windows into detected spells and ensures debouncing protocols.
5. **HandTracker.tsx** and **CanvasOverlay.tsx**
   UI visualisers using Canvas2D for hardware-accelerated drawing, glowing trails, debug mode bounding box data, and React state rendering.

### Getting Started

If you want to tweak parameters:

1. Open the UI and click the Debug ON button in the lower left to view real-time segments, generated direction identifiers, distance sizing, and FPS metrics.
2. Open motionGesture.ts and modify DEFAULT_MOTION_CONFIG to tweak the turn threshold limits.
3. Open spellRegistry.ts to add new gesture configurations safely.
