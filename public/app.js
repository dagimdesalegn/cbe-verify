const $ = (id) => document.getElementById(id);
const HISTORY_KEY = 'cbe_verify_history';
const KEY_STORAGE = 'cbe_verify_api_key';

function getApiKey() { return $('apiKey').value.trim(); }
function saveApiKey() { localStorage.setItem(KEY_STORAGE, getApiKey()); }
function loadApiKey() { const k = localStorage.getItem(KEY_STORAGE); if (k) $('apiKey').value = k; }

async function checkKey() {
  const key = getApiKey();
  if (!key) { $('keyStatus').textContent = 'Enter your API key'; $('keyStatus').className = 'text-xs mt-2 text-gray-500'; return false; }
  try {
    const res = await fetch('/api/api-keys', { headers: { 'x-api-key': key } });
    if (res.ok || res.status === 403) {
      $('keyStatus').textContent = 'Key valid';
      $('keyStatus').className = 'text-xs mt-2 text-green-400';
      return true;
    }
    $('keyStatus').textContent = 'Invalid key';
    $('keyStatus').className = 'text-xs mt-2 text-red-400';
    return false;
  } catch {
    $('keyStatus').textContent = 'Server unreachable';
    $('keyStatus').className = 'text-xs mt-2 text-yellow-400';
    return false;
  }
}

$('apiKey').addEventListener('input', () => { saveApiKey(); checkKey(); });
$('toggleKey').addEventListener('click', () => {
  const inp = $('apiKey');
  if (inp.type === 'password') { inp.type = 'text'; $('toggleKey').textContent = 'Hide'; }
  else { inp.type = 'password'; $('toggleKey').textContent = 'Show'; }
});

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => { b.classList.remove('tab-active'); b.classList.add('tab-inactive'); });
    btn.classList.remove('tab-inactive'); btn.classList.add('tab-active');
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    $('tab-' + btn.dataset.tab).classList.remove('hidden');
  });
});

async function verify(payload) {
  const key = getApiKey();
  if (!key) { showError('Enter your API key first'); return; }
  showLoading();
  try {
    const res = await fetch('/api/verify?waitMs=30000', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    showResult(data);
    if (data.success && data.data && data.data[0]) addToHistory(data.data[0]);
  } catch (e) { showError(e.message || 'Request failed'); }
}

$('verifySms').addEventListener('click', () => {
  const sms = $('smsText').value.trim();
  if (!sms) return showError('Paste the SMS text first');
  verify({ bank: 'cbe', referenceNumber: sms });
});
$('verifyRef').addEventListener('click', () => {
  const ref = $('refNumber').value.trim();
  const suffix = $('refSuffix').value.trim();
  if (!ref) return showError('Enter a reference number');
  verify({ bank: 'cbe', referenceNumber: ref, accountSuffix: suffix || undefined });
});
$('verifyUrl').addEventListener('click', () => {
  const url = $('receiptUrl').value.trim();
  if (!url) return showError('Paste a receipt URL');
  verify({ bank: 'cbe', referenceNumber: url });
});

function showLoading() {
  $('result').innerHTML = '<div class="card rounded-2xl p-8 flex flex-col items-center gap-3 fade-in"><div class="relative"><div class="w-12 h-12 rounded-full border-2 border-purple-500/30 absolute inset-0 pulse-ring"></div><svg class="w-12 h-12 text-purple-500 spinner" fill="none" viewBox="0 0 24 24"><circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle><path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"></path></svg></div><div class="text-sm text-gray-400">Verifying payment...</div><div class="text-xs text-gray-500">This may take up to 30 seconds</div></div>';
}
function showError(msg) {
  $('result').innerHTML = '<div class="card rounded-2xl p-6 fade-in border-red-900/50"><div class="flex items-start gap-3"><div class="w-10 h-10 rounded-full bg-red-900/30 flex items-center justify-center flex-shrink-0"><svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg></div><div><div class="font-medium text-red-300">Error</div><div class="text-sm text-gray-400 mt-1">' + escapeHtml(msg) + '</div></div></div></div>';
}
function showResult(res) {
  const item = res.data && res.data[0];
  if (!item) return showError(res.message || 'No data returned');
  if (item.status === 'success' && item.verified) {
    let fields = '';
    fields += field('Amount', fmtAmount(item.amount, item.currency));
    fields += field('Reference', item.referenceNumber);
    fields += field('Sender', item.senderName);
    fields += field('Sender account', item.senderAccount);
    fields += field('Receiver', item.receiverName);
    fields += field('Receiver account', item.receiverAccount);
    fields += field('Date', item.date);
    fields += field('Reason', item.reason);
    fields += field('Service charge', fmtAmount(item.serviceCharge, item.currency));
    fields += field('VAT', fmtAmount(item.vat, item.currency));
    fields += field('Total debited', fmtAmount(item.totalAmount, item.currency));
    fields += field('Bank', item.bank);
    $('result').innerHTML = '<div class="card rounded-2xl p-6 fade-in border-green-900/50"><div class="flex items-start gap-4"><div class="w-12 h-12 rounded-full bg-green-600/20 border border-green-600/40 flex items-center justify-center flex-shrink-0"><svg class="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg></div><div class="flex-1"><div class="font-semibold text-green-300 text-lg">Payment Verified</div><div class="text-sm text-gray-400 mt-1">This transaction is valid and confirmed.</div><div class="grid grid-cols-2 gap-4 mt-5 text-sm">' + fields + '</div></div></div></div>';
  } else if (item.status === 'not_found') {
    $('result').innerHTML = '<div class="card rounded-2xl p-6 fade-in border-yellow-900/50"><div class="flex items-start gap-4"><div class="w-12 h-12 rounded-full bg-yellow-600/20 border border-yellow-600/40 flex items-center justify-center flex-shrink-0"><svg class="w-6 h-6 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01"/></svg></div><div><div class="font-semibold text-yellow-300 text-lg">Not Found</div><div class="text-sm text-gray-400 mt-1">CBE did not return a receipt for this input.</div></div></div></div>';
  } else { showError(item.error || res.message || 'Verification failed'); }
}
function field(label, value) {
  return '<div><div class="text-xs text-gray-500 uppercase tracking-wide">' + escapeHtml(label) + '</div><div class="text-gray-100 mt-0.5 font-mono break-all">' + escapeHtml(value == null || value === '' ? '-' : value) + '</div></div>';
}
function fmtAmount(amount, currency) {
  if (amount == null) return '-';
  return Number(amount).toLocaleString() + ' ' + (currency || 'ETB');
}

function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
function saveHistory(h) { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 10))); }
function addToHistory(item) {
  const h = loadHistory();
  h.unshift({ ts: Date.now(), amount: item.amount, currency: item.currency, sender: item.senderName, receiver: item.receiverName, ref: item.referenceNumber, status: item.status });
  saveHistory(h); renderHistory();
}
function renderHistory() {
  const h = loadHistory();
  if (!h.length) { $('history').innerHTML = '<div class="text-xs text-gray-600 italic">No verifications yet</div>'; return; }
  $('history').innerHTML = h.map(function (r) {
    return '<div class="card rounded-xl px-4 py-3 flex items-center justify-between text-sm"><div class="flex items-center gap-3"><div class="w-2 h-2 rounded-full ' + (r.status === 'success' ? 'bg-green-500' : 'bg-yellow-500') + '"></div><div><div class="text-gray-200">' + escapeHtml(r.sender || '-') + ' to ' + escapeHtml(r.receiver || '-') + '</div><div class="text-xs text-gray-500 font-mono">' + escapeHtml(r.ref || '') + '</div></div></div><div class="text-right"><div class="text-gray-100">' + (r.amount ? Number(r.amount).toLocaleString() + ' ' + (r.currency || 'ETB') : '') + '</div><div class="text-xs text-gray-500">' + new Date(r.ts).toLocaleTimeString() + '</div></div></div>';
  }).join('');
}
$('clearHistory').addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); });

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); });
}

loadApiKey();
renderHistory();
if (getApiKey()) checkKey();