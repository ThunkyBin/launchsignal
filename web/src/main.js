import { createClient } from 'genlayer-js';
import { studionet, testnetBradbury, testnetAsimov } from 'genlayer-js/chains';
import './style.css';

const networks = {
  studionet: { label: 'Studionet', chain: studionet, explorer: 'https://explorer-studio.genlayer.com' },
  testnetBradbury: { label: 'Bradbury testnet', chain: testnetBradbury, explorer: 'https://explorer-bradbury.genlayer.com' },
  testnetAsimov: { label: 'Asimov testnet', chain: testnetAsimov, explorer: 'https://explorer-asimov.genlayer.com' },
};
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const maxUint = (1n << 256n) - 1n;
const el = (selector) => document.querySelector(selector);
const networkSelect = el('#network');
const addressInput = el('#contract-address');
const activity = el('#activity');

let networkKey = 'studionet';
let account = '';
let client;
let provider;
let preparedReview;
let pendingTx;

try {
  const savedPending = JSON.parse(localStorage.getItem('launchsignal.pending') || 'null');
  if (savedPending && /^0x[a-fA-F0-9]{64}$/.test(savedPending.hash)
    && networks[savedPending.networkKey] && addressPattern.test(savedPending.address)) {
    pendingTx = savedPending;
  }
} catch {
  pendingTx = undefined;
}

const params = new URLSearchParams(window.location.search);
if (networks[params.get('network')]) {
  networkKey = params.get('network');
  networkSelect.value = networkKey;
}
if (params.has('contract')) addressInput.value = params.get('contract');
const storedAddress = localStorage.getItem('launchsignal.contract');
const storedNetwork = localStorage.getItem('launchsignal.network');
if (!params.has('contract') && storedAddress) addressInput.value = storedAddress;
if (!params.has('network') && networks[storedNetwork]) {
  networkKey = storedNetwork;
  networkSelect.value = networkKey;
}
if (params.has('review')) el('#review-id').value = params.get('review');

function setActivity(message, isError = false) {
  activity.textContent = message;
  activity.classList.toggle('error', isError);
}

function getAddress() {
  const value = addressInput.value.trim();
  return addressPattern.test(value) ? value : '';
}

function readClient() {
  return createClient({ chain: networks[networkKey].chain });
}

function updateUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('network', networkKey);
  if (getAddress()) url.searchParams.set('contract', getAddress());
  if (el('#review-id').value.trim()) url.searchParams.set('review', el('#review-id').value.trim());
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}

function updatePrepareState() {
  const offer = el('#offer').value.trim();
  const pageUrl = el('#page-url').value.trim();
  el('#offer-count').textContent = `${el('#offer').value.length} / 280`;
  if (preparedReview && (preparedReview.offer !== offer || preparedReview.pageUrl !== pageUrl || !el('#public-consent').checked)) {
    preparedReview = undefined;
    el('#fee-panel').hidden = true;
  }
  el('#estimate-button').disabled = !(account && getAddress() && offer.length > 0 && offer.length <= 280
    && el('#public-consent').checked && !pendingForCurrentContract());
}

function pendingForCurrentContract() {
  return Boolean(pendingTx && pendingTx.networkKey === networkKey && pendingTx.address.toLowerCase() === getAddress().toLowerCase());
}

function showPendingNotice() {
  if (!pendingForCurrentContract()) return;
  const explorerUrl = `${networks[pendingTx.networkKey].explorer}/tx/${pendingTx.hash}`;
  setActivity('A previous review transaction is still being tracked. Do not submit it again.');
  const link = document.createElement('a');
  link.href = explorerUrl;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = 'Open transaction explorer';
  link.className = 'pending-link';
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'pending-check';
  check.textContent = 'Check final status';
  check.addEventListener('click', trackPendingTransaction);
  activity.append(' ', link, ' ', check);
}

async function trackPendingTransaction() {
  if (!pendingForCurrentContract()) return;
  const checked = pendingTx;
  const tracker = readClient();
  setActivity(`Checking ${checked.hash} for finalization…`);
  try {
    const receipt = await tracker.waitForTransactionReceipt({ hash: checked.hash, status: 'ACCEPTED' });
    if (pendingTx?.hash !== checked.hash) return;
    localStorage.removeItem('launchsignal.pending');
    pendingTx = undefined;
    if (receipt.txExecutionResultName === 'FINISHED_WITH_RETURN') {
      setActivity('The previous review finalized successfully. Loading the latest stored review…');
      const count = BigInt(String(await tracker.readContract({ address: checked.address, functionName: 'get_review_count', args: [] })));
      if (count > 0n) await loadReview(count - 1n);
    } else {
      setActivity(`The previous transaction finalized without a successful review (${receipt.statusName} / ${receipt.txExecutionResultName}). Check the explorer before retrying.`, true);
    }
  } catch (error) {
    setActivity(error instanceof Error ? `${error.message} The transaction remains locked against duplicate submission.` : 'The transaction is not final yet; it remains locked against duplicate submission.', true);
    showPendingNotice();
  } finally {
    updatePrepareState();
  }
}

function walletProvider() {
  return window.phantom?.ethereum || window.okxwallet || window.ethereum || null;
}

async function connectProviderToNetwork(selectedProvider, chain) {
  const chainId = `0x${chain.id.toString(16)}`;
  const currentChainId = await selectedProvider.request({ method: 'eth_chainId' });
  if (String(currentChainId).toLowerCase() === chainId.toLowerCase()) return;

  try {
    await selectedProvider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId }],
    });
  } catch (error) {
    if (Number(error?.code) !== 4902) throw error;
    const chainParams = {
      chainId,
      chainName: chain.name,
      rpcUrls: chain.rpcUrls.default.http,
      nativeCurrency: chain.nativeCurrency,
      ...(chain.blockExplorers?.default.url
        ? { blockExplorerUrls: [chain.blockExplorers.default.url] }
        : {}),
    };
    await selectedProvider.request({ method: 'wallet_addEthereumChain', params: [chainParams] });
    await selectedProvider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId }],
    });
  }

  const confirmedChainId = await selectedProvider.request({ method: 'eth_chainId' });
  if (String(confirmedChainId).toLowerCase() !== chainId.toLowerCase()) {
    throw new Error(`The wallet stayed on chain ${confirmedChainId}; switch it to ${chain.name} and reconnect.`);
  }
}

async function connectWallet() {
  provider = walletProvider();
  if (!provider?.request) {
    setActivity('No compatible EVM wallet was found. Enable a wallet that supports the selected GenLayer test network, then retry.', true);
    return;
  }
  el('#connect-wallet').disabled = true;
  setActivity(`Requesting wallet access for ${networks[networkKey].label}…`);
  try {
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!Array.isArray(accounts) || !accounts[0]) throw new Error('The wallet did not return an account.');
    account = accounts[0];
    client = createClient({ chain: networks[networkKey].chain, account, provider });
    await connectProviderToNetwork(provider, networks[networkKey].chain);
    el('#wallet-status').textContent = `${account.slice(0, 6)}…${account.slice(-4)} · connected`;
    el('#network-status').textContent = networks[networkKey].label;
    el('#connect-wallet').innerHTML = 'Wallet connected <span>✓</span>';
    setActivity(`Wallet connected to ${networks[networkKey].label}. Review inputs are still not submitted.`);
  } catch (error) {
    account = '';
    client = undefined;
    el('#wallet-status').textContent = 'Wallet not connected';
    const message = error instanceof Error
      ? error.message
      : (typeof error?.message === 'string' ? error.message : 'The wallet connection did not complete.');
    setActivity(message, true);
  } finally {
    el('#connect-wallet').disabled = false;
    updatePrepareState();
  }
}

function parseId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error('Enter a nonnegative whole-number review ID.');
  const id = BigInt(text);
  if (id > maxUint) throw new Error('Review ID must fit the contract uint256 range.');
  return id;
}

function parseRecord(raw) {
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    try { return JSON.parse(raw); } catch { throw new Error('The contract returned a malformed review record.'); }
  }
  return raw;
}

function flagLabel(value) {
  return value === true ? '✓' : '×';
}

function showReview(record, id) {
  el('#result-empty').hidden = true;
  el('#result-content').hidden = false;
  el('#result-card').classList.remove('empty-result');
  const status = String(record.status || 'UNCLEAR').toUpperCase();
  if (!['READY', 'NEEDS_WORK', 'UNCLEAR'].includes(status)) throw new Error('The contract returned an unknown review status.');
  el('#review-status').textContent = status.replace('_', ' ');
  el('#review-status').className = `status-pill ${status.toLowerCase().replace('_', '-')}`;
  el('#review-number').textContent = `REVIEW ${id.toString()}`;
  el('#review-label').textContent = `REVIEW ${id.toString()} · FINALIZED`;
  el('#review-offer').textContent = record.offer_statement || 'Offer statement unavailable.';
  let safeUrl;
  try { safeUrl = new URL(String(record.page_url)); } catch { safeUrl = null; }
  const pageLink = el('#review-url');
  if (safeUrl?.protocol === 'https:') {
    pageLink.href = safeUrl.href;
    pageLink.textContent = safeUrl.href;
    pageLink.hidden = false;
  } else {
    pageLink.removeAttribute('href');
    pageLink.textContent = 'Page URL unavailable.';
  }
  for (const flag of ['offer_visible', 'audience_clear', 'cta_clear', 'offer_matches']) {
    const marker = document.querySelector(`[data-flag="${flag}"]`);
    marker.textContent = flagLabel(record[flag]);
    marker.classList.toggle('pass', record[flag] === true);
    marker.classList.toggle('fail', record[flag] !== true);
  }
  el('#review-note').textContent = record.note || 'No leader note was stored.';
  const share = new URL(window.location.href);
  share.searchParams.set('network', networkKey);
  share.searchParams.set('contract', getAddress());
  share.searchParams.set('review', id.toString());
  const shareLink = el('#share-link');
  shareLink.href = share.toString();
  shareLink.onclick = async (event) => {
    event.preventDefault();
    try {
      await navigator.clipboard.writeText(share.toString());
      setActivity('Review link copied. Anyone with the link can read this public result.');
    } catch {
      window.prompt('Copy this public review link:', share.toString());
    }
  };
}

async function loadReview(id) {
  const address = getAddress();
  if (!address) throw new Error('Enter a valid deployed contract address first.');
  const read = readClient();
  const count = BigInt(String(await read.readContract({ address, functionName: 'get_review_count', args: [] })));
  el('#review-count').textContent = count.toString();
  el('#latest-button').disabled = count === 0n;
  if (id >= count) throw new Error(`No finalized review with ID ${id.toString()} exists yet.`);
  const record = parseRecord(await read.readContract({ address, functionName: 'get_review', args: [id] }));
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('No stored review was returned for this ID.');
  showReview(record, id);
  el('#review-id').value = id.toString();
  updateUrl();
  setActivity(`Review ${id.toString()} loaded from ${networks[networkKey].label}. Read only; no transaction was sent.`);
}

async function loadCount() {
  const address = getAddress();
  if (!address) {
    el('#review-count').textContent = '—';
    el('#latest-button').disabled = true;
    return;
  }
  try {
    const count = BigInt(String(await readClient().readContract({ address, functionName: 'get_review_count', args: [] })));
    el('#review-count').textContent = count.toString();
    el('#latest-button').disabled = count === 0n;
    if (params.has('review')) await loadReview(parseId(params.get('review')));
    else if (count > 0n) {
      el('#result-empty').hidden = false;
      el('#result-content').hidden = true;
      el('#review-label').textContent = `${count.toString()} REVIEWS STORED`;
      setActivity('Contract found. Choose a review ID or load the latest result.');
    } else setActivity('Contract found. No reviews have been stored yet.');
  } catch (error) {
    el('#review-count').textContent = '—';
    setActivity(error instanceof Error ? error.message : 'Could not read this contract.', true);
  }
}

async function prepareReview(event) {
  event.preventDefault();
  const address = getAddress();
  const pageUrl = el('#page-url').value.trim();
  const offer = el('#offer').value.trim();
  if (!address) return setActivity('Paste a valid deployed contract address first.', true);
  try {
    const parsedUrl = new URL(pageUrl);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || parsedUrl.port) {
      throw new Error('Use a public HTTPS page URL without credentials or an explicit port.');
    }
  } catch (error) {
    return setActivity(error instanceof Error ? error.message : 'Enter a valid public HTTPS URL.', true);
  }
  if (!offer || offer.length > 280) return setActivity('Write a public offer statement between 1 and 280 characters.', true);
  if (!el('#public-consent').checked) return setActivity('Confirm that the URL and offer sentence are public on-chain data.', true);
  if (!client || !account) return setActivity('Connect your wallet before requesting a fee estimate.', true);

  const write = { address, functionName: 'review_page', args: [pageUrl, offer] };
  el('#estimate-button').disabled = true;
  el('#fee-panel').hidden = true;
  setActivity('Running a preflight simulation. No transaction is being submitted…');
  try {
    await client.simulateWriteContract(write);
    preparedReview = { write, networkKey, address, pageUrl, offer };
    el('#fee-value').textContent = 'Passed';
    el('#fee-panel').hidden = false;
    setActivity('Preflight simulation passed. Check the network and any fee shown in your wallet before submitting.');
  } catch (error) {
    preparedReview = undefined;
    setActivity(error instanceof Error ? error.message : 'Could not estimate this review fee.', true);
  } finally {
    updatePrepareState();
  }
}

async function submitReview() {
  if (!preparedReview || !client || !account) return;
  if (pendingForCurrentContract()) return showPendingNotice();
  const current = preparedReview;
  if (current.networkKey !== networkKey || current.address !== getAddress()) {
    preparedReview = undefined;
    el('#fee-panel').hidden = true;
    return setActivity('The network or contract changed. Prepare a fresh estimate before submitting.', true);
  }
  if (!window.confirm(`Submit this page review on ${networks[networkKey].label}?\n\nThe page URL and offer sentence will be public on-chain data. Check any fee shown in your wallet before approving.`)) return;

  el('#submit-review').disabled = true;
  el('#estimate-button').disabled = true;
  setActivity('Waiting for wallet approval. Verify the test network and fee in your wallet…');
  let txHash;
  try {
    txHash = await client.writeContract(current.write);
  } catch (error) {
    el('#submit-review').disabled = false;
    updatePrepareState();
    setActivity(error instanceof Error ? error.message : 'The wallet did not submit this transaction.', true);
    return;
  }

  const txUrl = `${networks[networkKey].explorer}/tx/${txHash}`;
  const pending = { hash: txHash, networkKey, address: current.address };
  pendingTx = pending;
  localStorage.setItem('launchsignal.pending', JSON.stringify(pending));
  updatePrepareState();
  setActivity(`Transaction submitted: ${txHash}. Waiting for finalization. Do not submit the same review again. Explorer: ${txUrl}`);
  try {
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, status: 'ACCEPTED' });
    if (receipt.txExecutionResultName !== 'FINISHED_WITH_RETURN') {
      throw new Error(`Transaction did not succeed: ${receipt.statusName} / ${receipt.txExecutionResultName}. Inspect ${txUrl}`);
    }
    localStorage.removeItem('launchsignal.pending');
    pendingTx = undefined;
    preparedReview = undefined;
    el('#fee-panel').hidden = true;
    const id = BigInt(String(await client.readContract({ address: current.address, functionName: 'get_review_count', args: [] }))) - 1n;
    el('#review-id').value = id.toString();
    await loadReview(id);
    setActivity(`Review ${id.toString()} finalized on ${networks[networkKey].label}. Transaction: ${txUrl}`);
  } catch (error) {
    setActivity(error instanceof Error ? error.message : `Could not confirm the final status. Track the submitted transaction: ${txUrl}`, true);
  } finally {
    el('#submit-review').disabled = false;
    updatePrepareState();
  }
}

el('#connect-wallet').addEventListener('click', connectWallet);
el('#review-form').addEventListener('submit', prepareReview);
el('#submit-review').addEventListener('click', submitReview);
el('#offer').addEventListener('input', updatePrepareState);
el('#page-url').addEventListener('input', updatePrepareState);
el('#public-consent').addEventListener('change', updatePrepareState);
addressInput.addEventListener('change', () => {
  if (getAddress()) localStorage.setItem('launchsignal.contract', getAddress());
  updateUrl();
  loadCount();
  showPendingNotice();
  updatePrepareState();
});
el('#lookup-button').addEventListener('click', async () => {
  try { await loadReview(parseId(el('#review-id').value)); }
  catch (error) { setActivity(error instanceof Error ? error.message : 'Could not load the review.', true); }
});
el('#latest-button').addEventListener('click', async () => {
  try {
    const count = BigInt(String(await readClient().readContract({ address: getAddress(), functionName: 'get_review_count', args: [] })));
    if (count === 0n) throw new Error('This contract has no stored reviews yet.');
    await loadReview(count - 1n);
  } catch (error) { setActivity(error instanceof Error ? error.message : 'Could not load the latest review.', true); }
});
el('#review-id').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); el('#lookup-button').click(); }
});
networkSelect.addEventListener('change', () => {
  networkKey = networkSelect.value;
  localStorage.setItem('launchsignal.network', networkKey);
  params.set('network', networkKey);
  updateUrl();
  if (account) {
    account = '';
    client = undefined;
    el('#wallet-status').textContent = 'Reconnect wallet to the selected network';
    el('#connect-wallet').innerHTML = 'Connect wallet <span>↗</span>';
  }
  preparedReview = undefined;
  el('#fee-panel').hidden = true;
  el('#network-status').textContent = networks[networkKey].label;
  loadCount();
  showPendingNotice();
  updatePrepareState();
});

if (getAddress()) {
  localStorage.setItem('launchsignal.contract', getAddress());
  loadCount();
  showPendingNotice();
}
updatePrepareState();
