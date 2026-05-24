// Settings-page wiring for the listen (Web Speech API) feature.
//
// Pure prefs read/write lives in ./listen-prefs.js so it can be imported
// from reader-view.js (session pages) without dragging in this file's
// DOM-side effects (voice list population, voiceschanged listener,
// slider value labels).

import { loadPrefs, savePrefs } from './listen-prefs.js';

function populateVoiceSelect() {
  const select = document.getElementById('listenVoice');
  if (!select) return;

  const voices = window.speechSynthesis.getVoices();
  select.innerHTML = '<option value="">Default</option>';

  voices.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    select.appendChild(opt);
  });

  const prefs = loadPrefs();
  select.value = prefs.voice;
}

function bindRangeLabel(sliderId, labelId) {
  const slider = document.getElementById(sliderId);
  const label = document.getElementById(labelId);
  if (!slider || !label) return;
  const update = () => { label.textContent = parseFloat(slider.value).toFixed(1); };
  slider.addEventListener('input', update);
  update();
}

function initListenSettings() {
  if (!('speechSynthesis' in window)) return;
  // Only run on the settings page; bail out on other routes that may
  // happen to load this module (defensive — current Rust template only
  // includes it on /settings, but keep the contract local).
  if (!document.getElementById('listen-settings')) return;

  const voiceSelect = document.getElementById('listenVoice');
  const rateSlider = document.getElementById('listenRate');
  const pitchSlider = document.getElementById('listenPitch');
  const testBtn = document.getElementById('listenTest');

  const prefs = loadPrefs();
  if (voiceSelect) voiceSelect.value = prefs.voice;
  if (rateSlider) rateSlider.value = prefs.rate;
  if (pitchSlider) pitchSlider.value = prefs.pitch;

  populateVoiceSelect();
  // Voices populate asynchronously in Chrome; addEventListener avoids
  // clobbering any other listener and is supported everywhere we ship.
  window.speechSynthesis.addEventListener('voiceschanged', populateVoiceSelect);

  bindRangeLabel('listenRate', 'listenRateValue');
  bindRangeLabel('listenPitch', 'listenPitchValue');

  const save = () => {
    savePrefs({
      voice: voiceSelect ? voiceSelect.value : '',
      rate: rateSlider ? parseFloat(rateSlider.value) : 1.0,
      pitch: pitchSlider ? parseFloat(pitchSlider.value) : 1.0,
    });
  };

  if (voiceSelect) voiceSelect.addEventListener('change', save);
  if (rateSlider) rateSlider.addEventListener('input', save);
  if (pitchSlider) pitchSlider.addEventListener('input', save);

  if (testBtn) {
    testBtn.addEventListener('click', () => {
      window.speechSynthesis.cancel();
      const current = loadPrefs();
      const utterance = new SpeechSynthesisUtterance('Mobux listen mode test, one two three');

      if (current.voice) {
        const voices = window.speechSynthesis.getVoices();
        const selected = voices.find((v) => v.name === current.voice);
        if (selected) utterance.voice = selected;
      }

      utterance.rate = current.rate;
      utterance.pitch = current.pitch;
      window.speechSynthesis.speak(utterance);
    });
  }
}

export { initListenSettings, loadPrefs };

if (typeof window !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initListenSettings);
} else if (typeof window !== 'undefined') {
  initListenSettings();
}
