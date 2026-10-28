const output = document.querySelector("#output");
const clearButton = document.querySelector("#clear");
const rawLogButton = document.querySelector("#open-log");
const api = window.petConsole;

function append(line) {
  if (typeof line !== "string" || line.length === 0) return;
  const atBottom = output.scrollTop + output.clientHeight >= output.scrollHeight - 8;
  output.textContent += `${line}\n`;
  if (atBottom) output.scrollTop = output.scrollHeight;
}

api.onHistory((lines) => {
  output.textContent = "";
  for (const line of Array.isArray(lines) ? lines : []) append(line);
  output.scrollTop = output.scrollHeight;
});

api.onLine(append);

clearButton.addEventListener("click", () => {
  output.textContent = "";
  void api.clear();
});

rawLogButton.addEventListener("click", () => {
  void api.openRawLog();
});
