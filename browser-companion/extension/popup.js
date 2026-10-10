const status = document.getElementById("status");
async function refresh() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "status" });
    status.textContent = result?.connected ? "Connected to Easy Social" :
      result?.connecting ? "Connecting to Easy Social…" : result?.error || "Not connected";
  } catch { status.textContent = "Extension background is unavailable."; }
}
document.getElementById("pair").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = document.getElementById("code").value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(code)) { status.textContent = "Enter a valid 64-character pairing code."; return; }
  const result = await chrome.runtime.sendMessage({ type: "pair", code });
  document.getElementById("code").value = "";
  status.textContent = result.error || "Pairing submitted. Checking connection…";
  await refresh();
});
document.getElementById("disconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnect" });
  await refresh();
});
document.getElementById("reconnect").addEventListener("click", async () => {
  status.textContent = "Retrying the saved browser connection…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "reconnect" });
    if (result?.error) status.textContent = result.error;
    else await refresh();
  } catch { status.textContent = "Could not reconnect. Check the local bridge."; }
});
void refresh();
setInterval(() => void refresh(), 2000);
