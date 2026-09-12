
const input = document.getElementById('qinput');
const emailInput = document.getElementById('qemail');
const btn = document.getElementById('qbtn');
let busy = false;
async function ask() {
  const q = input.value.trim();
  if (!q || busy) return;
  busy = true; btn.disabled = true;
  answerEl.hidden = false; answerEl.textContent = 'Thinking...';
  try {
    const res = await fetch('https://hvitxwhfdhsdwhgllaqf.supabase.co/functions/v1/site', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, email: emailInput.value.trim() })
    });
    const data = await res.json();
    if (res.ok && data.answer) {
      answerEl.textContent = data.answer;
      if (window.qaHighlight) window.qaHighlight(q + ' ' + data.answer);
    } else if (res.status === 202 && data.queued) {
      answerEl.textContent = data.email_captured
        ? 'The live assistant is offline right now, so your question has been logged. You will receive an answer by email within one business day.'
        : 'The live assistant is offline right now. Your question has been logged for Dan. Leave your email above and ask again to get the answer sent to you, or email deenikdaniel@gmail.com directly.';
      if (window.qaHighlight) window.qaHighlight(q);
    } else if (res.status === 429) {
      answerEl.textContent = 'The assistant is busy right now. The quick answers above cover the most common questions, or email deenikdaniel@gmail.com.';
    } else {
      answerEl.textContent = 'The assistant is momentarily unavailable. Use the quick answers above, or email deenikdaniel@gmail.com and Dan will respond directly.';
    }
  } catch (e) {
    answerEl.textContent = 'Connection issue. Use the quick answers above, or email deenikdaniel@gmail.com.';
  }
  busy = false; btn.disabled = false;
}
btn.addEventListener('click', ask);
input.addEventListener('keydown', function(e){ if (e.key === 'Enter') ask(); });

// LinkedIn share: share the page the visitor is actually on.
(function(){
  const s = document.getElementById('liShare');
  if (s && location.protocol.indexOf('http') === 0){
    s.href = 'https://www.linkedin.com/sharing/share-offsite/?url=' + encodeURIComponent(location.href);
  }
})();
