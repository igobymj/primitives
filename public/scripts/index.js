import GameSession from "./engine/GameSession.js";

// Resume Tone.js AudioContext on first user interaction (browser autoplay policy)
function resumeAudioContext() {
  Tone.start();
  document.removeEventListener('click', resumeAudioContext);
  document.removeEventListener('keydown', resumeAudioContext);
}
document.addEventListener('click', resumeAudioContext);
document.addEventListener('keydown', resumeAudioContext);

const gameSession = new GameSession();

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
