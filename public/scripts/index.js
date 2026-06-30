import GameSession from "./engine/GameSession.js";
import Creature from "./game/Creature.js";
import CreatureManager from "./game/CreatureManager.js";
import FoodManager from "./game/FoodManager.js";
import Editor from "./editor/Editor.js";
import JuiceEditor from "./editor/JuiceEditor.js";
import { renderText, measureText } from "./game/VectorText.js";

// Resume Tone.js AudioContext on first user interaction (browser autoplay policy)
function resumeAudioContext() {
  Tone.start();
  document.removeEventListener('click', resumeAudioContext);
  document.removeEventListener('keydown', resumeAudioContext);
}
document.addEventListener('click', resumeAudioContext);
document.addEventListener('keydown', resumeAudioContext);

const gameSession = new GameSession();
gameSession.backgroundColor = '#f3ecdc'; // warm cream

// Enable the master juice toggle and seed the per-event juice settings. The
// juice editor mode reads/writes these directly; juiceEventManager.addNew
// consults them when an event fires.
gameSession.juiceSettings.extend({
  cheats: { juiceFx: true },
  // sillyColors is referenced by VectorParticleEffect to override per-particle
  // hue. We don't expose it in the UI; just stub it so the access doesn't throw.
  sillyColors: { active: false, particleHue: 0 },
  'line attaches': {
    shake: {
      active: true,
      xAxis: true,
      yAxis: true,
      amplitude: 0.5,
      // Frequency stays below the 30Hz Nyquist limit of a 60fps canvas so the
      // sine doesn't alias to ~0 every frame.
      frequency: 10,
      duration: 0.35,
      form: 'sine',
      fade: 'exponential',
      inheritVelocity: false,
    },
    particles: {
      active: true,
      particleSystem: 'attachBurst',
    },
    timeSlow: {
      active: false,
      scale: 0.4,
      duration: 0.2,
    },
  },
});

// Particle system definitions live separately from the per-event juice
// container. 'line attaches'.particles.particleSystem points at this key.
gameSession.juiceSettings.extendParticleSystems({
  attachBurst: {
    vectorParticle: {
      shape: 'circle',
      count: 12,
      size: 6,
      pattern: 'radial',
      rotation: 'random',
      rotationSpeed: 4,
      particleLife: 1.0,
      initialVelocityRandom: true,
      initialVelocity: 35,
      fade: true,
      followObject: false,
      inheritVelocity: false,
      gravity: false,
      fill: false,
      color: '#ffaa3c', // warm amber
    },
  },
});

const creatureManager = new CreatureManager(gameSession);
const foodManager = new FoodManager(gameSession, creatureManager);
// InputManager polls held keys (WASD) each frame; runs before consumers.
gameSession.gameLoop.addUpdateSystem('input', gameSession.inputManager, 0);
// Food runs before creatures so newly consumed lines render the same frame.
gameSession.gameLoop.addUpdateSystem('food', foodManager, 50);
gameSession.gameLoop.addRenderSystem('food', foodManager, 50);
gameSession.gameLoop.addUpdateSystem('creatures', creatureManager, 100);
gameSession.gameLoop.addRenderSystem('creatures', creatureManager, 100);
// Juice runs last so a translate() from a shake effector lands on the matrix
// after all other systems have updated, and any rendered effects layer on top.
gameSession.gameLoop.addUpdateSystem('juice', gameSession.juiceEventManager, 200);
gameSession.gameLoop.addRenderSystem('juice', gameSession.juiceEventManager, 200);

// "space to attach" HUD — vector text rendered in the upper-right of the
// canvas, only in play mode, and matrix-reset so screen shake doesn't drag
// the HUD with the rest of the scene.
const playHud = {
  update() {},
  render() {
    if (currentMode !== 'play') return;
    const p = gameSession.p5;
    const text = 'space to attach';
    const sizePx = 22;
    const margin = 24;
    const textWidth = measureText(text) * sizePx;
    const x = gameSession.canvasWidth - textWidth - margin;
    const y = margin - 6; // top of glyph cell sits at y + 0.2*sizePx
    p.push();
    p.resetMatrix();
    p.noFill();
    p.stroke(20, 18, 14, 200);
    p.strokeWeight(1.5);
    p.strokeCap(p.ROUND);
    p.strokeJoin(p.ROUND);
    renderText(p, text, x, y, sizePx);
    p.pop();
  },
};
gameSession.gameLoop.addRenderSystem('hud', playHud, 250);

// Route all mouse + key input through the engine's InputManager.
gameSession.inputManager.addMouseHandler(creatureManager);
gameSession.inputManager.addKeyHandler((key) => creatureManager.keyPressed(key));
gameSession.inputManager.addKeyHandler((key) => foodManager.keyPressed(key));

const PANEL_WIDTH = 260;

function createCreature(x, y) {
  const cx = x ?? (gameSession.canvasWidth - PANEL_WIDTH) / 2 + (Math.random() - 0.5) * 80;
  const cy = y ?? gameSession.canvasHeight / 2 + (Math.random() - 0.5) * 80;
  // Play-mode creatures start with a touch of life in their deformation
  // (slow out-of-round shape); jitter (twitchy per-vertex bumps) starts at
  // 0 and ramps up only while food is near. Editor creatures start crisp
  // so the slider's baseline is predictable.
  const deformation = creatureManager.mode === 'play'
    ? 0.4 + Math.random() * 0.2
    : 0;
  const creature = new Creature(gameSession, cx, cy, {
    bodyRadius: 24,
    arms: [],
    deformation,
    jitter: 0,
  });
  creatureManager.add(creature);
  if (creatureManager.mode === 'editor') creatureManager.select(creature);
  return creature;
}


const editor = new Editor(creatureManager, document.getElementById('editor-panel'), createCreature);

// Pull in saved juice settings (if any) before constructing the JuiceEditor
// so its initial UI reflects what's on disk. deepMerge in extend() means the
// file overlays the in-code defaults — missing keys keep their defaults.
try {
  const res = await fetch('public/scripts/data/juice.json');
  if (res.ok) {
    const data = await res.json();
    if (data && data.container) gameSession.juiceSettings.extend(data.container);
    if (data && data.particleSystems) gameSession.juiceSettings.extendParticleSystems(data.particleSystems);
  }
} catch (e) {
  // No saved file or fetch error — keep defaults.
}

const juiceEditor = new JuiceEditor(gameSession.juiceSettings, document.getElementById('juice-panel'));
creatureManager.onSpawnRequest = (x, y) => createCreature(x, y);

let currentMode = 'play';
creatureManager.mode = currentMode;
foodManager.enable();
function setMode(mode) {
  if (mode === currentMode) return;
  currentMode = mode;
  creatureManager.mode = mode;
  document.body.classList.toggle('mode-play', mode === 'play');
  document.body.classList.toggle('mode-editor', mode === 'editor');
  document.body.classList.toggle('mode-juice', mode === 'juice');
  document.querySelectorAll('#mode-tabs .tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  // Clear editor-only state when leaving editor mode.
  if (mode !== 'editor') {
    creatureManager.select(null);
  }
  // Food is live in both play and juice modes — so editing juice while
  // the creature animates and eats food gives immediate visual feedback.
  if (mode === 'editor') foodManager.disable();
  else foodManager.enable();
}
document.body.classList.add('mode-play');
document.querySelectorAll('#mode-tabs .tab').forEach((btn) => {
  btn.classList.toggle('active', btn.dataset.mode === currentMode);
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

const sketch = function (p) {

  p.setup = function () {
    const canvasDiv = document.getElementById('canvas');
    gameSession.canvasWidth = canvasDiv.clientWidth;
    gameSession.canvasHeight = canvasDiv.clientHeight;

    const canvas = p.createCanvas(gameSession.canvasWidth, gameSession.canvasHeight);
    canvas.parent('canvas');
    gameSession.canvas = canvas;

    gameSession.timeManager.timeScale = 1;
    gameSession.timeManager.frameRate = 60;
    gameSession.timeManager.start();

    p.frameRate(60);
    p.imageMode(p.CENTER);
  }

  p.draw = function () {
    gameSession.timeManager.update();
    gameSession.gameLoop.update();

    p.background(p.color(gameSession.backgroundColor));
    gameSession.gameLoop.render();

    if (gameSession.flashColor != 0) {
      p.fill(gameSession.flashColor);
      p.rect(0, 0, gameSession.canvasWidth, gameSession.canvasHeight);
    }
  }

  p.mousePressed = function () {
    // Ignore clicks above the canvas (the mode tab bar).
    if (p.mouseY < 0) return;
    // Ignore clicks on the visible right-side panel (editor or juice).
    // Play mode has no panel — clicks pass through.
    const sidePanelWidth = currentMode === 'editor' ? PANEL_WIDTH
                         : currentMode === 'juice'  ? 300
                         : 0;
    if (sidePanelWidth > 0 && p.mouseX > p.windowWidth - sidePanelWidth) return;
    gameSession.inputManager.mousePressed(p.mouseX, p.mouseY);
  }

  p.mouseDragged = function () {
    gameSession.inputManager.mouseDragged(p.mouseX, p.mouseY);
  }

  p.mouseReleased = function () {
    gameSession.inputManager.mouseReleased();
  }

  p.keyPressed = function () {
    gameSession.inputManager.keyInput(p.key);
  }

  p.windowResized = function () {
    const canvasDiv = document.getElementById('canvas');
    gameSession.canvasWidth = canvasDiv.clientWidth;
    gameSession.canvasHeight = canvasDiv.clientHeight;
    p.resizeCanvas(gameSession.canvasWidth, gameSession.canvasHeight);
  }
}

gameSession.p5 = new p5(sketch, 'canvas');
