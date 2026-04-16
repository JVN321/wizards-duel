/**
 * gameEngine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Stateful Wizard Duel game engine.
 *
 * Responsibilities:
 *   - Player health tracking (player vs. AI wizard)
 *   - Spell cooldown management
 *   - Active status effects with expiry
 *   - Combo chain tracking (consecutive casts within a window)
 *   - Turn-based AI response
 *
 * Usage: Create one instance; call `castSpell(spellId)` on detection.
 * Engine emits events via a simple subscriber system.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  SPELL_REGISTRY,
  type SpellId,
  type SpellDefinition,
  type SpellEffect,
} from "./spellRegistry";

// ─── State types ──────────────────────────────────────────────────────────────

export type ActiveEffect = {
  id: string;              // unique per application
  spellId: SpellId;
  status: SpellEffect["status"];
  startedAt: number;
  durationMs: number;
  tickDamage: number;      // DoT damage per second
};

export type FighterState = {
  hp: number;
  maxHp: number;
  shieldStrength: number;  // 0–100; 0 = no shield
  effects: ActiveEffect[];
  name: string;
};

export type CooldownMap = Partial<Record<SpellId, number>>;  // spellId → ready-after timestamp

export type ComboEntry = {
  spellId: SpellId;
  castedAt: number;
};

export type GamePhase = "idle" | "dueling" | "victory" | "defeat";

export type GameState = {
  phase: GamePhase;
  player: FighterState;
  opponent: FighterState;
  cooldowns: CooldownMap;
  combo: ComboEntry[];
  lastCastedSpell: SpellId | null;
  score: number;
  round: number;
};

// ─── Engine events ────────────────────────────────────────────────────────────

export type EngineEvent =
  | { type: "spell_cast";   spellId: SpellId; confidence: number }
  | { type: "spell_hit";    spellId: SpellId; target: "player" | "opponent"; damage: number }
  | { type: "shield_up";    target: "player" | "opponent"; strength: number }
  | { type: "effect_apply"; target: "player" | "opponent"; effect: ActiveEffect }
  | { type: "effect_expire";target: "player" | "opponent"; effectId: string }
  | { type: "combo";        count: number; multiplier: number }
  | { type: "opponent_cast";spellId: SpellId }
  | { type: "state_change"; state: Readonly<GameState> }
  | { type: "game_over";    winner: "player" | "opponent" };

export type EventListener = (event: EngineEvent) => void;

// ─── Constants ────────────────────────────────────────────────────────────────

const PLAYER_MAX_HP = 100;
const OPPONENT_MAX_HP = 100;
const COMBO_WINDOW_MS = 3500;       // consecutive casts counted within this window
const DOT_INTERVAL_MS = 1000;       // bleeding DoT tick interval
const DOT_DAMAGE_PER_TICK = 4;      // damage per bleed tick
const OPPONENT_AI_DELAY_MS = 1200;  // AI response delay after player casts

// ─── AI spell pool (spells the AI opponent will randomly cast) ────────────────

const AI_SPELL_POOL: SpellId[] = [
  "stupefy",
  "expelliarmus",
  "bombarda",
  "protego",
  "sectumsempra",
  "aguamenti",
];

// ─── Game Engine ─────────────────────────────────────────────────────────────

export class GameEngine {
  private state: GameState;
  private listeners: Set<EventListener> = new Set();
  private dotIntervalId: ReturnType<typeof setInterval> | null = null;
  private aiTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.state = this.buildInitialState();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getState(): Readonly<GameState> {
    return this.state;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startDuel(): void {
    this.state = this.buildInitialState();
    this.state.phase = "dueling";
    this.startDotTimer();
    this.emit({ type: "state_change", state: this.state });
  }

  reset(): void {
    this.clearTimers();
    this.state = this.buildInitialState();
    this.emit({ type: "state_change", state: this.state });
  }

  /**
   * Main entry point — called by the MotionRecognizer when a spell is detected.
   * Returns false if the spell is on cooldown or blocked by a status effect.
   */
  castSpell(spellId: SpellId, confidence: number): boolean {
    if (this.state.phase !== "dueling") return false;

    // Check cooldown
    const readyAt = this.state.cooldowns[spellId] ?? 0;
    if (Date.now() < readyAt) return false;

    // Check if player is stunned / frozen
    const isIncapacitated = this.state.player.effects.some(
      (e) => e.status === "stunned" || e.status === "frozen",
    );
    if (isIncapacitated) return false;

    const spell = SPELL_REGISTRY[spellId];

    // Emit cast event
    this.emit({ type: "spell_cast", spellId, confidence });

    // Set cooldown
    this.state = {
      ...this.state,
      cooldowns: {
        ...this.state.cooldowns,
        [spellId]: Date.now() + spell.cooldownMs,
      },
      lastCastedSpell: spellId,
    };

    // Record combo
    this.recordCombo(spellId);

    // Apply spell effect
    this.applySpellEffect(spell, "opponent");

    // Score update
    const comboMultiplier = this.getComboMultiplier();
    const points = Math.round(
      (spell.effect.damage + spell.effect.pushback * 0.3) * confidence * comboMultiplier,
    );
    this.state = { ...this.state, score: this.state.score + points };

    // Trigger AI response
    this.scheduleAiResponse();

    this.emit({ type: "state_change", state: this.state });
    return true;
  }

  /** Check if a spell is currently on cooldown */
  isCoolingDown(spellId: SpellId): boolean {
    const readyAt = this.state.cooldowns[spellId] ?? 0;
    return Date.now() < readyAt;
  }

  /** Remaining cooldown ms for a spell (0 if ready) */
  cooldownRemaining(spellId: SpellId): number {
    const readyAt = this.state.cooldowns[spellId] ?? 0;
    return Math.max(0, readyAt - Date.now());
  }

  destroy(): void {
    this.clearTimers();
    this.listeners.clear();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private buildInitialState(): GameState {
    return {
      phase: "idle",
      player: {
        hp: PLAYER_MAX_HP,
        maxHp: PLAYER_MAX_HP,
        shieldStrength: 0,
        effects: [],
        name: "You",
      },
      opponent: {
        hp: OPPONENT_MAX_HP,
        maxHp: OPPONENT_MAX_HP,
        shieldStrength: 0,
        effects: [],
        name: "Dark Wizard",
      },
      cooldowns: {},
      combo: [],
      lastCastedSpell: null,
      score: 0,
      round: 1,
    };
  }

  private applySpellEffect(
    spell: SpellDefinition,
    target: "player" | "opponent",
  ): void {
    const fighter = target === "player" ? "player" : "opponent";
    const { effect } = spell;

    if (effect.status === "shielded") {
      // Shield the caster (player), not the target
      this.state = {
        ...this.state,
        player: {
          ...this.state.player,
          shieldStrength: Math.min(100, this.state.player.shieldStrength + effect.shieldStrength),
        },
      };
      this.emit({ type: "shield_up", target: "player", strength: effect.shieldStrength });
      return;
    }

    // Absorb damage with shield
    let damage = effect.damage;
    if (damage > 0) {
      const targetFighter = this.state[fighter];
      if (targetFighter.shieldStrength > 0) {
        const absorbed = Math.min(damage, targetFighter.shieldStrength);
        damage -= absorbed;
        this.state = {
          ...this.state,
          [fighter]: {
            ...targetFighter,
            shieldStrength: targetFighter.shieldStrength - absorbed,
          },
        };
      }
    }

    // Instant damage
    if (damage > 0) {
      const targetFighter = this.state[fighter];
      const newHp = Math.max(0, targetFighter.hp - damage);
      this.state = {
        ...this.state,
        [fighter]: { ...targetFighter, hp: newHp },
      };
      this.emit({ type: "spell_hit", spellId: spell.id, target, damage });
    }

    // Status effect
    if (effect.status !== "none" && effect.durationMs > 0) {
      const activeEffect: ActiveEffect = {
        id: `${spell.id}_${Date.now()}`,
        spellId: spell.id,
        status: effect.status,
        startedAt: Date.now(),
        durationMs: effect.durationMs,
        tickDamage: effect.status === "bleeding" ? DOT_DAMAGE_PER_TICK : 0,
      };

      const targetFighter = this.state[fighter];
      this.state = {
        ...this.state,
        [fighter]: {
          ...targetFighter,
          effects: [...targetFighter.effects, activeEffect],
        },
      };
      this.emit({ type: "effect_apply", target, effect: activeEffect });
    }

    // Check for game over
    this.checkGameOver();
  }

  private recordCombo(spellId: SpellId): void {
    const now = Date.now();
    const recentCombo = this.state.combo.filter(
      (c) => now - c.castedAt <= COMBO_WINDOW_MS,
    );
    const updated = [...recentCombo, { spellId, castedAt: now }];
    this.state = { ...this.state, combo: updated };

    if (updated.length >= 2) {
      this.emit({ type: "combo", count: updated.length, multiplier: this.getComboMultiplier() });
    }
  }

  private getComboMultiplier(): number {
    const count = this.state.combo.filter(
      (c) => Date.now() - c.castedAt <= COMBO_WINDOW_MS,
    ).length;
    if (count < 2) return 1;
    if (count < 3) return 1.25;
    if (count < 5) return 1.5;
    return 2.0;
  }

  private scheduleAiResponse(): void {
    if (this.aiTimeoutId !== null) return;

    const delay = OPPONENT_AI_DELAY_MS + Math.random() * 800;
    this.aiTimeoutId = setTimeout(() => {
      this.aiTimeoutId = null;
      this.runAiTurn();
    }, delay);
  }

  private runAiTurn(): void {
    if (this.state.phase !== "dueling") return;

    // AI picks a random available spell
    const available = AI_SPELL_POOL.filter((id) => !this.isCoolingDown(id));
    if (available.length === 0) return;

    const index = Math.floor(Math.random() * available.length);
    const spellId = available[index];
    const spell = SPELL_REGISTRY[spellId];

    this.emit({ type: "opponent_cast", spellId });

    // Set AI cooldown
    this.state = {
      ...this.state,
      cooldowns: {
        ...this.state.cooldowns,
        [spellId]: Date.now() + spell.cooldownMs,
      },
    };

    // Apply effect to player
    this.applySpellEffect(spell, "player");
    this.emit({ type: "state_change", state: this.state });
  }

  private startDotTimer(): void {
    if (this.dotIntervalId !== null) return;

    this.dotIntervalId = setInterval(() => {
      this.tickDoTs();
    }, DOT_INTERVAL_MS);
  }

  private tickDoTs(): void {
    if (this.state.phase !== "dueling") return;

    const now = Date.now();
    let changed = false;

    for (const target of ["player", "opponent"] as const) {
      const fighter = this.state[target];
      const surviving: ActiveEffect[] = [];

      for (const effect of fighter.effects) {
        const elapsed = now - effect.startedAt;
        if (elapsed >= effect.durationMs) {
          // Expire effect
          this.emit({ type: "effect_expire", target, effectId: effect.id });

          // Remove shield when shield effect expires
          if (effect.status === "shielded") {
            this.state = {
              ...this.state,
              [target]: { ...this.state[target], shieldStrength: 0 },
            };
          }
          changed = true;
          continue;
        }

        // Tick DoT
        if (effect.tickDamage > 0) {
          const currentHp = this.state[target].hp;
          const newHp = Math.max(0, currentHp - effect.tickDamage);
          this.state = {
            ...this.state,
            [target]: { ...this.state[target], hp: newHp },
          };
          this.emit({
            type: "spell_hit",
            spellId: effect.spellId,
            target,
            damage: effect.tickDamage,
          });
          changed = true;
        }

        surviving.push(effect);
      }

      if (surviving.length !== fighter.effects.length) {
        this.state = {
          ...this.state,
          [target]: { ...this.state[target], effects: surviving },
        };
        changed = true;
      }
    }

    if (changed) {
      this.checkGameOver();
      this.emit({ type: "state_change", state: this.state });
    }
  }

  private checkGameOver(): void {
    if (this.state.player.hp <= 0) {
      this.state = { ...this.state, phase: "defeat" };
      this.clearTimers();
      this.emit({ type: "game_over", winner: "opponent" });
    } else if (this.state.opponent.hp <= 0) {
      this.state = { ...this.state, phase: "victory" };
      this.clearTimers();
      this.emit({ type: "game_over", winner: "player" });
    }
  }

  private clearTimers(): void {
    if (this.dotIntervalId !== null) {
      clearInterval(this.dotIntervalId);
      this.dotIntervalId = null;
    }
    if (this.aiTimeoutId !== null) {
      clearTimeout(this.aiTimeoutId);
      this.aiTimeoutId = null;
    }
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

// ─── Singleton for client-side usage ─────────────────────────────────────────

let _engine: GameEngine | null = null;

export function getGameEngine(): GameEngine {
  if (!_engine) {
    _engine = new GameEngine();
  }
  return _engine;
}
