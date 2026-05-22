const STORAGE_KEY = 'mobux.listen.prefs';
const DEFAULT_PREFS = { voice: '', rate: 1.0, pitch: 1.0 };

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch (_) {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (_) {}
}

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

function initListenSettings() {
  if (!('speechSynthesis' in window)) return;

  const voiceSelect = document.getElementById('listenVoice');
  const rateSlider = document.getElementById('listenRate');
  const pitchSlider = document.getElementById('listenPitch');
  const testBtn = document.getElementById('listenTest');

  const prefs = loadPrefs();
  if (voiceSelect) voiceSelect.value = prefs.voice;
  if (rateSlider) rateSlider.value = prefs.rate;
  if (pitchSlider) pitchSlider.value = prefs.pitch;

  populateVoiceSelect();
  
  if (window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = populateVoiceSelect;
  }

  const save = () => {
    const updated = {
      voice: voiceSelect ? voiceSelect.value : '',
      rate: rateSlider ? parseFloat(rateSlider.value) : 1.0,
      pitch: pitchSlider ? parseFloat(pitchSlider.value) : 1.0,
    };
    savePrefs(updated);
  };

  if (voiceSelect) voiceSelect.addEventListener('change', save);
  if (rateSlider) rateSlider.addEventListener('input', save);
  if (pitchSlider) pitchSlider.addEventListener('input', save);

  if (testBtn) {
    testBtn.addEventListener('click', () => {
      window.speechSynthesis.cancel();
      const prefs = loadPrefs();
      const utterance = new SpeechSynthesisUtterance('Mobux listen mode test, one two three');
      
      if (prefs.voice) {
        const voices = window.speechSynthesis.getVoices();
        const selected = voices.find((v) => v.name === prefs.voice);
        if (selected) utterance.voice = selected;
      }
      
      utterance.rate = prefs.rate;
      utterance.pitch = prefs.pitch;
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
