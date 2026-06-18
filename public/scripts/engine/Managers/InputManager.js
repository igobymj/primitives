/*
 * InputManager — base class
 *
 * Aggregates per-frame held-key state into `inputObject` and dispatches
 * one-shot keypresses through `keyInput()`. Game-specific bindings belong
 * in a subclass that overrides `update()` and `keyInput()`.
 */

import Manager from "./Manager.js";

export default class InputManager extends Manager {

    constructor(gameSession) {
        if (InputManager.__instance) {
            return InputManager.__instance;
        }

        super(gameSession);

        InputManager.__instance = this;

        this.__inputObject = {};

        if (this.gameSession.verbose === true) {
            console.log("input manager created successfully");
        }
    }

    update() {
        // Override in a subclass to read held keys via this.gameSession.p5.keyIsDown(...)
    }

    keyInput(keyInputValue) {
        // Override in a subclass to handle one-shot keypresses.
    }

    get inputObject() {
        return this.__inputObject;
    }

    set inputObject(input) {
        this.__inputObject = input;
    }

    get instance() {
        return this.__instance;
    }

    set instance(instance) {
        this.__instance = instance;
    }
}
