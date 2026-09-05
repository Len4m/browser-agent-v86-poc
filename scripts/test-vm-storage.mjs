#!/usr/bin/env node
/* global document, HTMLButtonElement */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(root, "public/v86/images/profiles/alpine-base.json");
const runtimeContract = JSON.parse(readFileSync(join(root, "vm", "runtime-contract.json"), "utf8"));
const chromiumPath = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const port = Number(process.env.VM_STORAGE_TEST_PORT || 5186);

function fail(message) {
  console.error(`ERROR test:vm-storage: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(manifestPath)) {
  fail("falta el perfil generado alpine-base. Ejecuta pnpm setup antes de esta prueba E2E.");
  process.exit();
}
if (!existsSync(chromiumPath)) {
  fail(`no se encuentra Chromium en ${chromiumPath}; define CHROMIUM_PATH.`);
  process.exit();
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
for (const asset of [manifest.assets?.kernel, manifest.assets?.initramfs, manifest.assets?.persistentSeed]) {
  const url = String(asset?.url || "").split("?")[0];
  if (!url || !existsSync(join(root, "public", url.replace(/^\//, "")))) {
    fail(`falta el asset ${url || "desconocido"}. Ejecuta pnpm setup.`);
    process.exit();
  }
}
const rootPart = String(manifest.assets?.rootfs?.url || "").replace(/\.img\.zst$/, `-0-${runtimeContract.rootPartSize}.img.zst`);
if (!existsSync(join(root, "public", rootPart.replace(/^\//, "")))) {
  fail(`falta la primera parte HDA ${rootPart}. Ejecuta pnpm setup.`);
  process.exit();
}

const build = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), IP: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server.mjs no arrancó a tiempo");
}

let browser;
let page;
const browserErrors = [];
const browserConsole = [];
try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ acceptDownloads: true, locale: "es-ES" });
  page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => browserConsole.push(`${message.type()}: ${message.text()}`));
  page.on("requestfailed", (request) => browserConsole.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ""}`));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  if (await page.locator('#vm-ram-mb option[value="256"]').count()) throw new Error("la opción RAM de 256 MB sigue visible sin perfiles compatibles");
  await page.selectOption("#vm-profile", "alpine-pentest-web");
  if (await page.locator("#vm-ram-mb").inputValue() !== "1536") throw new Error("el perfil web no aplica su RAM mínima");
  for (const value of ["512", "768", "1024"]) {
    if (!await page.locator(`#vm-ram-mb option[value="${value}"]`).evaluate((option) => option.disabled)) {
      throw new Error(`el perfil web permite RAM inferior a su mínimo: ${value} MB`);
    }
  }
  await page.selectOption("#vm-profile", "alpine-base");
  if (await page.locator("#vm-ram-mb").inputValue() !== "512") throw new Error("el perfil base no aplica su RAM mínima");
  if (await page.locator('#vm-ram-mb option[value="512"]').evaluate((option) => option.disabled)) throw new Error("la RAM mínima del perfil base está deshabilitada");
  if (await page.locator("#vm-ram-mb").isDisabled() || await page.locator("#vm-vram-mb").isDisabled()) throw new Error("RAM/VRAM no son configurables en el perfil");
  await page.selectOption("#vm-ram-mb", "768");
  await page.selectOption("#vm-vram-mb", "16");
  if (await page.locator("#vm-disk").count()) throw new Error("el selector de disco legacy sigue presente");
  if (await page.locator("#workspace-toolbar").isVisible()) throw new Error("el workspace aparece sin activar persistencia");
  if (await page.locator("#workspace-import, #workspace-export, #workspace-import-file").count()) {
    throw new Error("la importación/exportación portable del workspace sigue presente");
  }

  const bootStarted = Date.now();
  await page.click("#start-vm");
  await page.locator("#badge-vm.good").waitFor({ state: "visible", timeout: 120000 });
  if (await page.locator("#check-disk").count()) throw new Error("Montar disco sigue presente sin discos seleccionables");
  const bootMs = Date.now() - bootStarted;
  await page.locator("details.tool-log-details > summary").click();

  async function command(text, expected) {
    const before = await page.locator("#terminal").textContent() || "";
    const previousMatches = before.split(String(expected)).length - 1;
    await page.fill("#command-input", text);
    await page.locator("#command-form button").click();
    await page.waitForFunction(({ needle, previous }) => {
      const text = document.querySelector("#terminal")?.textContent || "";
      return text.split(String(needle)).length - 1 > previous;
    }, { needle: expected, previous: previousMatches }, { timeout: 60000 });
  }

  const temporaryMarker = `TEMP_${Date.now()}`;
  await command(`printf '${temporaryMarker}\n' > /root/.ba-temporary-e2e; cat /root/.ba-temporary-e2e`, temporaryMarker);
  await page.click("#start-vm");
  await page.locator("#ba-modal-actions .ba-modal-button.danger").click();
  await page.waitForFunction(() => (document.querySelector("#save-state") instanceof HTMLButtonElement) && document.querySelector("#save-state").disabled, null, { timeout: 60000 });
  await page.click("#start-vm");
  await page.locator("#badge-vm.good").waitFor({ state: "visible", timeout: 60000 });
  await command("test ! -e /root/.ba-temporary-e2e && echo TEMPORARY_CLEAN", "TEMPORARY_CLEAN");
  await page.click("#start-vm");
  await page.locator("#ba-modal-actions .ba-modal-button.danger").click();
  await page.waitForFunction(() => (document.querySelector("#save-state") instanceof HTMLButtonElement) && document.querySelector("#save-state").disabled, null, { timeout: 60000 });

  await page.selectOption("#vm-storage-mode", "persistent");
  if (await page.locator("#workspace-toolbar").isVisible()) throw new Error("el workspace aparece antes de tener datos persistidos");
  if (await page.locator("#vm-profile-storage-status").isVisible()) throw new Error("la información del workspace aparece sin datos persistidos");
  await page.click("#start-vm");
  await page.locator("#badge-vm.good").waitFor({ state: "visible", timeout: 60000 });

  const marker = `PERSIST_${Date.now()}`;
  await command(`test ! -e /run/browser-agent-init-rescue || exit 97; printf '${marker}\\n' > /root/.ba-persistent-e2e; sync; cat /root/.ba-persistent-e2e`, marker);
  await page.locator("#vm-profile-storage-status").filter({ hasText: "Datos persistentes" }).waitFor({ state: "visible" });
  await page.locator("#workspace-toolbar").waitFor({ state: "visible" });
  const workspaceDetail = await page.locator("#vm-profile-storage-status").textContent() || "";
  if (!/datos persistentes.*\d+(?:[.,]\d+)? (?:B|KB|MB|GB)/i.test(workspaceDetail) || workspaceDetail.includes("/")) {
    throw new Error(`el tamaño superior no corresponde solo al workspace: ${workspaceDetail}`);
  }
  if (!(await page.locator('#vm-profile option[value="alpine-base"]').textContent())?.includes("💾")) {
    throw new Error("el perfil con datos persistentes no muestra el icono de guardado");
  }
  await page.click("#start-vm");
  await page.locator("#ba-modal-actions .ba-modal-button.danger").click();
  await page.waitForFunction(() => (document.querySelector("#save-state") instanceof HTMLButtonElement) && document.querySelector("#save-state").disabled, null, { timeout: 60000 });

  await page.selectOption("#vm-storage-mode", "temporary");
  await page.locator("#workspace-toolbar").waitFor({ state: "hidden" });
  if (!await page.locator("#vm-profile-storage-status").isVisible()) throw new Error("el tamaño desaparece al usar una sesión temporal");
  await page.selectOption("#vm-storage-mode", "persistent");
  await page.locator("#workspace-toolbar").waitFor({ state: "visible" });

  await page.selectOption("#vm-ram-mb", "512");
  await page.selectOption("#vm-vram-mb", "8");
  await page.click("#start-vm");
  await page.locator("#badge-vm.good").waitFor({ state: "visible", timeout: 60000 });
  await command("cat /root/.ba-persistent-e2e", marker);

  await page.click("#new-console");
  await page.locator("#console-tabs-list .console-tab").nth(1).waitFor({ state: "visible", timeout: 10000 });
  const restoredConsoleName = `Trabajo ${Date.now()}`;
  await page.locator("#console-tabs-list .console-tab").nth(1).dblclick();
  await page.fill("#ba-console-rename-input", restoredConsoleName);
  await page.locator("#ba-modal-actions .ba-modal-button.primary").click();
  await page.locator("#console-tabs-list .console-tab.active .console-tab-label").filter({ hasText: restoredConsoleName }).waitFor({ state: "visible" });
  const ptyBeforeSnapshot = `PTY_BEFORE_${Date.now()}`;
  await page.locator("#xterm-console-host .xterm-console-pane:not([hidden]) textarea").click();
  await page.keyboard.type(`echo ${ptyBeforeSnapshot}`);
  await page.keyboard.press("Enter");
  await page.locator("#xterm-console-host .xterm-console-pane:not([hidden]) .xterm-rows").filter({ hasText: ptyBeforeSnapshot }).waitFor({ state: "visible", timeout: 10000 });

  const snapshotDownload = page.waitForEvent("download", { timeout: 180000 });
  await page.click("#save-state");
  const snapshot = await snapshotDownload;
  if (!snapshot.suggestedFilename().endsWith(".bav86snapshot")) throw new Error("extensión de snapshot incorrecta");
  const snapshotPath = await snapshot.path();
  if (!snapshotPath) throw new Error("Playwright no expuso el snapshot descargado para restaurarlo");

  const restoreContext = await browser.newContext({ acceptDownloads: true, locale: "es-ES" });
  const restorePage = await restoreContext.newPage();
  restorePage.on("pageerror", (error) => browserErrors.push(error.message));
  restorePage.on("console", (message) => browserConsole.push(`${message.type()}: ${message.text()}`));
  await restorePage.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await restorePage.locator("#vm-profile option[value='alpine-base']").waitFor({ state: "attached", timeout: 30000 });
  page = restorePage;
  await page.locator("#restore-state-file").setInputFiles(snapshotPath);
  await page.waitForFunction(() => {
    const badge = document.querySelector("#badge-vm");
    return badge?.classList.contains("good") || badge?.classList.contains("bad");
  }, null, { timeout: 180000 });
  if (!(await page.locator("#badge-vm").evaluate((badge) => badge.classList.contains("good")))) {
    throw new Error(`restore rechazado: ${await page.locator("#vm-detail").textContent()}`);
  }
  if (await page.locator("#vm-ram-mb").inputValue() !== "512" || await page.locator("#vm-vram-mb").inputValue() !== "8") {
    throw new Error("el snapshot no restauró su configuración RAM/VRAM");
  }
  if (await page.locator("#vm-storage-mode").inputValue() !== "persistent") {
    throw new Error("el snapshot persistente no restauró el modo workspace");
  }
  await page.locator("#console-tabs-list .console-tab.active .console-tab-label").filter({ hasText: restoredConsoleName }).waitFor({ state: "visible", timeout: 10000 });
  const restoredPty = page.locator("#xterm-console-host .xterm-console-pane:not([hidden]) .xterm-rows");
  await restoredPty.filter({ hasText: "#" }).waitFor({ state: "visible", timeout: 10000 });
  const ptyAfterRestore = `PTY_AFTER_${Date.now()}`;
  await page.locator("#xterm-console-host .xterm-console-pane:not([hidden]) textarea").click();
  await page.keyboard.type(`echo ${ptyAfterRestore}`);
  await page.keyboard.press("Enter");
  await restoredPty.filter({ hasText: ptyAfterRestore }).waitFor({ state: "visible", timeout: 10000 });
  await page.locator("details.tool-log-details > summary").click();
  await command("cat /root/.ba-persistent-e2e", marker);

  await page.click("#start-vm");
  await page.locator("#ba-modal-actions .ba-modal-button.danger").click();
  await page.waitForFunction(() => (document.querySelector("#save-state") instanceof HTMLButtonElement) && document.querySelector("#save-state").disabled, null, { timeout: 60000 });
  await page.waitForFunction(() => (document.querySelector("#workspace-reset") instanceof HTMLButtonElement) && !document.querySelector("#workspace-reset").disabled, null, { timeout: 10000 });
  await page.click("#workspace-reset");
  await page.locator("#ba-modal-actions .ba-modal-button.danger").click();
  await page.locator("#vm-profile-storage-status").waitFor({ state: "hidden", timeout: 10000 });
  await page.locator("#workspace-toolbar").waitFor({ state: "hidden", timeout: 10000 });
  await page.click("#start-vm");
  await page.locator("#badge-vm.good").waitFor({ state: "visible", timeout: 60000 });
  await command("test ! -e /root/.ba-persistent-e2e && echo WORKSPACE_RESET_OK", "WORKSPACE_RESET_OK");
  await restoreContext.close();
  if (browserErrors.length) throw new Error(`errores de página: ${browserErrors.join(" | ")}`);

  console.log(`OK test:vm-storage: sesión temporal descartada y workspace persistió /root (${bootMs} ms primer arranque)`);
  console.log(`OK snapshot persistente restauró HDB, PTY utilizable, nombre y pestaña activa: ${snapshot.suggestedFilename()}`);
  console.log("OK workspace local reiniciado desde su semilla inmutable");
} catch (error) {
  if (page) {
    const serial = await page.locator("#serial-console .xterm-rows").innerText().catch(() => "");
    const tools = await page.locator("#terminal").textContent().catch(() => "");
    const badge = await page.locator("#badge-vm").textContent().catch(() => "");
    const detail = await page.locator("#vm-detail").textContent().catch(() => "");
    console.error(`--- serial console ---\n${String(serial).slice(-12000)}`);
    console.error(`--- tool log ---\n${String(tools).slice(-6000)}`);
    console.error(`--- status ---\nbadge=${badge} detail=${detail}`);
    console.error(`--- browser ---\n${[...browserErrors, ...browserConsole].slice(-100).join("\n")}`);
  }
  fail(error instanceof Error ? error.stack || error.message : String(error));
} finally {
  await browser?.close().catch(() => {});
  server.kill("SIGTERM");
}
