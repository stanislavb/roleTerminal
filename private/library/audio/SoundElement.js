/*
 Copyright 2015 Aleksandar Jankovic

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

/** @namespace Audio */

class SoundElement {
  /**
   * @param {string} params.path - Path to the file
   * @param {string} params.soundId - Identification of the sound element
   */
  constructor({ path, soundId }) {
    this.audio = new Audio();
    this.audio.src = path;
    this.soundId = soundId;
  }

  /**
   * @param {Number} [params.startTime] - Starting time of the audio
   * @param {Number} [params.volume] - Volume for the audio
   */
  playAudio({ startTime, volume }) {
    if (startTime) {
      this.audio.currentTime = startTime;
    }

    if (volume) {
      this.audio.volume = volume;
    }

    this.audio.play();
  }

  /**
   * Pauses the audio
   */
  pauseAudio() {
    this.audio.pause();
  }

  /**
   * Pauses audio and resets time and volume parameters
   */
  resetAudio() {
    this.audio.pause();
    this.audio.currentTime = 0;
    this.audio.volume = 1;
  }

  /**
   * Sets new audio volume
   * @param {Number} level - New audio volume
   */
  setVolume(level) {
    this.audio.volume = level;
  }
}

module.exports = SoundElement;
