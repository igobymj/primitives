import GameSession from "./engine/GameSession.js";
import Creature from "./game/Creature.js";
import CreatureManager from "./game/CreatureManager.js";
import Editor from "./editor/Editor.js";

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

const creatureManager = new CreatureManager(gameSession);
// InputManager polls held keys (WASD) each frame; runs before consumers.
gameSession.gameLoop.addUpdateSystem('input', gameSession.inputManager, 0);
gameSession.gameLoop.addUpdateSystem('creatures', creatureManager, 100);
gameSession.gameLoop.addRenderSystem('creatures', creatureManager, 100);

// Route all mouse + key input through the engine's InputManager.
gameSession.inputManager.addMouseHandler(creatureManager);
gameSession.inputManager.addKeyHandler((key) => creatureManager.keyPressed(key));

const PANEL_WIDTH = 260;

function createCreature() {
  const cx = (gameSession.canvasWidth - PANEL_WIDTH) / 2 + (Math.random() - 0.5) * 80;
  const cy = gameSession.canvasHeight / 2 + (Math.random() - 0.5) * 80;
  const creature = new Creature(gameSession, cx, cy, {
    bodyRadius: 24,
    arms: [],
    jitter: 0,
  });
  creatureManager.add(creature);
  creatureManager.select(creature);
}

const editor = new Editor(creatureManager, document.getElementById('editor-panel'), createCreature);

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
    // Ignore clicks on the editor panel (p5 mouse events fire window-wide)
    if (p.mouseX > p.windowWidth - PANEL_WIDTH) return;
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
