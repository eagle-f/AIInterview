const form = document.querySelector('#settings');
const status = document.querySelector('#status');
const save = document.querySelector('#save');

window.apiSettings.read().then((result) => {
  if (!result.ok) throw new Error(result.message);
  for (const [key, value] of Object.entries(result.config)) {
    const input = form.elements.namedItem(key);
    if (input) input.value = value;
  }
}).catch((error) => { status.textContent = error.message; });

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  save.disabled = true;
  status.textContent = '正在保存并重新连接…';
  try {
    const result = await window.apiSettings.save(Object.fromEntries(new FormData(form)));
    if (!result.ok) throw new Error(result.message);
    status.textContent = '已保存，连接已更新。';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    save.disabled = false;
  }
});
