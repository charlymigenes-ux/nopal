(function () {
  "use strict";

  /* ==================================================
     CONFIGURACIÓN DE ENVÍO
     GitHub Pages es estático: sin backend propio. El formulario
     inserta directo contra la API REST de Supabase (proyecto "NOPAL Colab")
     usando la clave publishable — segura para el cliente porque el acceso
     real lo controla RLS (la tabla solo permite INSERT, nunca SELECT, desde
     el navegador). Si FORM_CONFIG.endpoint queda vacío, se activa el
     MODO DEMO (no se envía nada a ningún servidor).
     ================================================== */
  const FORM_CONFIG = {
    endpoint: "https://vphmstxbejjcnwltrffa.supabase.co/rest/v1/collaborations",
    method: "POST",
    apiKey: "sb_publishable_kDfqzwYTK5dCf5wmVI5oOw_2g6Ip5X2"
  };

  /* Traduce el estado anidado del wizard a las columnas planas de
     public.collaborations (ver migración create_collaborations). */
  function toSupabaseRow(data) {
    return {
      collaboration_types: data.collaborationTypes,
      equipment_type: data.equipment.type || null,
      equipment_brand: data.equipment.brand || null,
      equipment_model: data.equipment.model || null,
      equipment_custom_name: data.equipment.customName || null,
      equipment_board_manufacturer: data.equipment.boardManufacturer || null,
      equipment_board_model: data.equipment.boardModel || null,
      equipment_quantity: data.equipment.quantity || 1,
      condition_status: data.condition.status || null,
      condition_problems: data.condition.problems,
      condition_description: data.condition.description || null,
      availability_options: data.availability.options,
      availability_shipping: data.availability.shipping || null,
      availability_asking_price: data.availability.askingPrice === "" ? null : data.availability.askingPrice,
      availability_currency: data.availability.currency || null,
      availability_negotiable: data.availability.negotiable === "si" ? true : data.availability.negotiable === "no" ? false : null,
      technical_firmware: data.technical.firmware || null,
      technical_connections: data.technical.connections,
      technical_operating_system: data.technical.operatingSystem || null,
      technical_experience_level: data.technical.experienceLevel || null,
      technical_notes: data.technical.notes || null,
      contact_name: data.contact.name.trim(),
      contact_email: data.contact.email.trim(),
      contact_facebook: data.contact.facebook || null,
      contact_discord: data.contact.discord || null,
      contact_github: data.contact.github || null,
      contact_telegram: data.contact.telegram || null,
      contact_whatsapp: data.contact.whatsapp || null,
      contact_other: data.contact.other || null,
      location_country: data.location.country.trim(),
      location_state: data.location.state || null,
      location_city: data.location.city || null,
      consent: data.consent
    };
  }

  async function submitCollaboration(data) {
    const row = toSupabaseRow(data);

    if (!FORM_CONFIG.endpoint) {
      console.log("[NOPAL Colabora] MODO DEMO — no hay backend configurado. Payload que se enviaría:");
      console.log(row);
      return { demo: true };
    }

    const res = await fetch(FORM_CONFIG.endpoint, {
      method: FORM_CONFIG.method,
      headers: {
        "Content-Type": "application/json",
        "apikey": FORM_CONFIG.apiKey,
        "Authorization": "Bearer " + FORM_CONFIG.apiKey,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(row)
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error("No se pudo enviar el registro (" + res.status + ") " + detail);
    }
    return { demo: false };
  }

  /* ==================================================
     ESTADO
     ================================================== */
  const STORAGE_KEY = "nopal_colabora_v1";

  function emptyState() {
    return {
      collaborationTypes: [],
      equipment: {
        type: "", brand: "", model: "", customName: "",
        boardManufacturer: "", boardModel: "", quantity: 1
      },
      condition: { status: "", problems: [], description: "" },
      availability: {
        options: [], shipping: "", askingPrice: "", currency: "", negotiable: null
      },
      technical: {
        firmware: "", connections: [], operatingSystem: "", experienceLevel: "", notes: ""
      },
      location: { country: "", state: "", city: "" },
      contact: {
        name: "", email: "", facebook: "", discord: "", github: "",
        telegram: "", whatsapp: "", other: ""
      },
      consent: false
    };
  }

  let state = emptyState();
  let currentStep = 1;
  const TOTAL_STEPS = 5;

  // Fotos en memoria — NUNCA en localStorage, NUNCA en el objeto enviado (sin backend real).
  const photos = { equipment: null, board: null, additional: [] };

  /* ==================================================
     PERSISTENCIA LOCAL (sin fotos, sin credenciales)
     ================================================== */
  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, currentStep }));
    } catch (e) { /* almacenamiento no disponible, se ignora */ }
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.state) {
        state = Object.assign(emptyState(), parsed.state);
        currentStep = parsed.currentStep || 1;
      }
    } catch (e) { /* datos corruptos, se ignora y se arranca limpio */ }
  }

  function clearLocal() {
    localStorage.removeItem(STORAGE_KEY);
    state = emptyState();
    currentStep = 1;
    photos.equipment = null;
    photos.board = null;
    photos.additional = [];
    ["dz-equipment-preview", "dz-board-preview", "dz-additional-preview"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    });
    document.getElementById("collab-form").reset();
    document.getElementById("f-quantity").value = 1;
    applyStateToForm();
    goToStep(1);
    updateSummary();
    showToast("Formulario borrado.");
  }

  /* ==================================================
     HELPERS DE PATH (equipment.type -> state.equipment.type)
     ================================================== */
  function getPath(obj, path) {
    return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
  }
  function setPath(obj, path, value) {
    const keys = path.split(".");
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = value;
  }

  const form = document.getElementById("collab-form");

  function applyStateToForm() {
    form.querySelectorAll("[name]").forEach(el => {
      const name = el.name;
      const value = getPath(state, name);
      if (el.type === "checkbox") {
        if (name === "consent") {
          el.checked = !!state.consent;
        } else {
          const arr = Array.isArray(value) ? value : [];
          el.checked = arr.indexOf(el.value) !== -1;
        }
      } else if (el.type === "radio") {
        el.checked = value === el.value;
      } else if (value !== undefined && value !== null) {
        el.value = value;
      }
    });
  }

  function readFieldToState(el) {
    const name = el.name;
    if (!name) return;
    if (name === "consent") {
      state.consent = el.checked;
      return;
    }
    if (el.type === "checkbox") {
      const arr = Array.isArray(getPath(state, name)) ? getPath(state, name).slice() : [];
      const idx = arr.indexOf(el.value);
      if (el.checked && idx === -1) arr.push(el.value);
      if (!el.checked && idx !== -1) arr.splice(idx, 1);
      setPath(state, name, arr);
    } else if (el.type === "radio") {
      if (el.checked) setPath(state, name, el.value);
    } else if (el.type === "number") {
      setPath(state, name, el.value === "" ? "" : Number(el.value));
    } else {
      setPath(state, name, el.value);
    }
  }

  form.addEventListener("input", handleFieldChange);
  form.addEventListener("change", handleFieldChange);

  function handleFieldChange(e) {
    const el = e.target;
    if (!el.name) return;
    readFieldToState(el);
    refreshConditionalBlocks();
    updateSummary();
    saveLocal();
  }

  /* ==================================================
     BLOQUES CONDICIONALES
     ================================================== */
  function refreshConditionalBlocks() {
    const showProblems = ["parcial", "falla", "no-enciende"].indexOf(state.condition.status) !== -1;
    document.getElementById("problems-block").hidden = !showProblems;

    const showSell = state.availability.options.indexOf("vender") !== -1;
    document.getElementById("sell-block").hidden = !showSell;

    const needsShipping = ["prestar-equipo", "prestar-placa", "donar", "enviar"].some(
      v => state.availability.options.indexOf(v) !== -1
    );
    document.getElementById("shipping-block").hidden = !needsShipping;
  }

  /* ==================================================
     NAVEGACIÓN DE PASOS
     ================================================== */
  const stepPanels = document.querySelectorAll(".step-panel");
  const stepNavItems = document.querySelectorAll(".step-item");
  const btnPrev = document.getElementById("btn-prev");
  const btnNext = document.getElementById("btn-next");
  const btnSubmit = document.getElementById("btn-submit");

  function validateStep(step) {
    if (step === 1) {
      const ok = state.collaborationTypes.length > 0;
      toggleError("err-step1", !ok);
      return ok;
    }
    if (step === 2) {
      const ok = !!state.equipment.type;
      toggleError("err-step2", !ok);
      return ok;
    }
    if (step === 3) {
      const ok = !!state.condition.status;
      toggleError("err-step3", !ok);
      return ok;
    }
    if (step === 4) {
      const ok = state.availability.options.length > 0;
      toggleError("err-step4", !ok);
      return ok;
    }
    if (step === 5) {
      const nameOk = state.contact.name.trim().length > 0;
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.contact.email.trim());
      const countryOk = state.location.country.trim().length > 0;
      toggleError("err-step5", !(nameOk && emailOk && countryOk));
      toggleError("err-consent", !state.consent);
      return nameOk && emailOk && countryOk && state.consent;
    }
    return true;
  }

  function toggleError(id, show) {
    const el = document.getElementById(id);
    if (el) el.hidden = !show;
  }

  function goToStep(step) {
    step = Math.min(Math.max(step, 1), TOTAL_STEPS);
    currentStep = step;

    stepPanels.forEach(panel => {
      panel.hidden = Number(panel.dataset.step) !== step;
    });

    stepNavItems.forEach(item => {
      const n = Number(item.dataset.step);
      item.classList.toggle("active", n === step);
      item.classList.toggle("done", n < step);
    });

    btnPrev.disabled = step === 1;
    const isLast = step === TOTAL_STEPS;
    btnNext.hidden = isLast;
    btnSubmit.hidden = !isLast;

    document.getElementById("mobile-step-current").textContent = step;
    document.getElementById("mobile-progress-fill").style.width = (step / TOTAL_STEPS * 100) + "%";

    if (step === TOTAL_STEPS) {
      document.getElementById("side-right").classList.add("expanded");
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  btnNext.addEventListener("click", () => {
    if (validateStep(currentStep)) {
      saveLocal();
      goToStep(currentStep + 1);
    }
  });
  btnPrev.addEventListener("click", () => goToStep(currentStep - 1));

  stepNavItems.forEach(item => {
    item.addEventListener("click", () => {
      const target = Number(item.dataset.step);
      if (target <= currentStep) { goToStep(target); return; }
      // avanzar saltando pasos: valida cada paso intermedio
      for (let s = currentStep; s < target; s++) {
        if (!validateStep(s)) { goToStep(s); return; }
      }
      goToStep(target);
    });
  });

  document.getElementById("btn-clear").addEventListener("click", () => {
    if (confirm("¿Borrar todo el progreso del formulario?")) clearLocal();
  });

  /* ==================================================
     RESUMEN EN VIVO
     ================================================== */
  const LABELS = {
    equipmentType: {
      impresora3d: "Impresora 3D", laser: "Láser", cnc: "CNC / Router",
      placa: "Placa electrónica", "esp-arduino": "ESP32 / ESP8266 / Arduino",
      accesorio: "Accesorio", otro: "Otro"
    },
    status: {
      funciona: "🟢 Funciona correctamente", parcial: "🟡 Funciona parcialmente",
      falla: "🔴 Tiene una falla", "no-enciende": "⚫ No enciende",
      reemplazada: "🔵 Fue reemplazada pero la conservo", "no-seguro": "❓ No estoy seguro"
    },
    problems: {
      usb: "USB", drivers: "Drivers", motores: "Motores", temperaturas: "Temperaturas",
      calentadores: "Calentadores", pantalla: "Pantalla", wifi: "Wi-Fi", ethernet: "Ethernet",
      firmware: "Firmware", arranque: "Arranque", alimentacion: "Alimentación",
      comunicacion: "Comunicación", sensores: "Sensores", conectores: "Conectores",
      "daño-fisico": "Daño físico", otro: "Otro"
    },
    participation: {
      tester: "🧪 Tester", fallas: "⚠️ Reporta falla", donar: "❤️ Donación",
      prestar: "🤝 Préstamo", vender: "🏷️ Venta", remoto: "💻 Pruebas remotas",
      tecnico: "🛠️ Técnico", info: "ℹ️ Solo información"
    }
  };

  function updateSummary() {
    const hasAny = state.collaborationTypes.length || state.equipment.type ||
      state.condition.status || state.equipment.customName;

    document.getElementById("summary-empty").hidden = !!hasAny;
    document.getElementById("summary-list").hidden = !hasAny;
    if (!hasAny) return;

    const typeLabel = LABELS.equipmentType[state.equipment.type] || "—";
    const equipName = state.equipment.customName || state.equipment.model || "";
    document.getElementById("sum-equipment").textContent =
      equipName ? typeLabel + " — " + equipName : typeLabel;

    const board = [state.equipment.boardManufacturer, state.equipment.boardModel].filter(Boolean).join(" ");
    document.getElementById("sum-board").textContent = board || "—";

    document.getElementById("sum-status").textContent = LABELS.status[state.condition.status] || "—";

    const problemsRow = document.getElementById("sum-problems-row");
    if (state.condition.problems.length) {
      problemsRow.hidden = false;
      document.getElementById("sum-problems").textContent =
        state.condition.problems.map(p => LABELS.problems[p] || p).join(" / ");
    } else {
      problemsRow.hidden = true;
    }

    const participationEl = document.getElementById("sum-participation");
    participationEl.innerHTML = "";
    state.collaborationTypes.forEach(t => {
      const span = document.createElement("span");
      span.className = "tag";
      span.textContent = LABELS.participation[t] || t;
      participationEl.appendChild(span);
    });
    if (!state.collaborationTypes.length) participationEl.textContent = "—";

    document.getElementById("sum-location").textContent = state.location.country || "—";
  }

  document.getElementById("mobile-summary-toggle").addEventListener("click", () => {
    document.getElementById("side-right").classList.toggle("expanded");
    const caret = document.getElementById("mobile-summary-caret");
    const expanded = document.getElementById("side-right").classList.contains("expanded");
    caret.innerHTML = expanded ? "&#9652;" : "&#9662;";
  });

  /* ==================================================
     DROPZONES DE FOTOGRAFÍAS (solo en memoria, sin localStorage)
     ================================================== */
  function setupDropzone(zoneId, inputId, previewId, multiple, store) {
    const zone = document.getElementById(zoneId);
    const input = document.getElementById(inputId);
    const preview = document.getElementById(previewId);

    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") input.click(); });

    ["dragover", "dragenter"].forEach(evt =>
      zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.add("drag"); })
    );
    ["dragleave", "dragend", "drop"].forEach(evt =>
      zone.addEventListener(evt, () => zone.classList.remove("drag"))
    );
    zone.addEventListener("drop", e => {
      e.preventDefault();
      handleFiles(e.dataTransfer.files);
    });
    input.addEventListener("change", () => handleFiles(input.files));

    function handleFiles(fileList) {
      const files = Array.from(fileList).filter(f => f.type.startsWith("image/"));
      if (!files.length) return;
      if (multiple) {
        files.forEach(f => { store.additional.push(f); renderThumb(f, () => {
          const idx = store.additional.indexOf(f);
          if (idx !== -1) store.additional.splice(idx, 1);
        }); });
      } else {
        preview.innerHTML = "";
        const f = files[0];
        if (zoneId === "dz-equipment") store.equipment = f; else store.board = f;
        renderThumb(f, () => {
          if (zoneId === "dz-equipment") store.equipment = null; else store.board = null;
        });
      }
      input.value = "";
    }

    function renderThumb(file, onRemove) {
      const url = URL.createObjectURL(file);
      const item = document.createElement("div");
      item.className = "preview-item";
      const img = document.createElement("img");
      img.src = url;
      img.alt = file.name;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "rm";
      rm.textContent = "×";
      rm.addEventListener("click", e => {
        e.stopPropagation();
        onRemove();
        item.remove();
        URL.revokeObjectURL(url);
      });
      item.appendChild(img);
      item.appendChild(rm);
      preview.appendChild(item);
    }
  }

  setupDropzone("dz-equipment", "dz-equipment-input", "dz-equipment-preview", false, photos);
  setupDropzone("dz-board", "dz-board-input", "dz-board-preview", false, photos);
  setupDropzone("dz-additional", "dz-additional-input", "dz-additional-preview", true, photos);

  /* ==================================================
     ENVÍO
     ================================================== */
  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (!validateStep(5)) return;

    btnSubmit.disabled = true;
    const notice = document.getElementById("demo-notice");
    notice.hidden = true;

    try {
      const result = await submitCollaboration(JSON.parse(JSON.stringify(state)));
      if (result && result.demo) {
        notice.hidden = false;
        notice.innerHTML = "<b>MODO DEMO:</b> este formulario todavía no está conectado a ningún servidor. " +
          "Tu registro <b>no fue enviado</b>. Se generó el objeto completo y puedes verlo abierto en la consola del navegador (F12).";
        showToast("Modo demo: revisa la consola del navegador.");
      } else {
        showToast("¡Registro enviado! Gracias por colaborar.");
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (err) {
      notice.hidden = false;
      notice.innerHTML = "<b>Error:</b> " + err.message;
    } finally {
      btnSubmit.disabled = false;
    }
  });

  /* ==================================================
     TOAST
     ================================================== */
  let toastTimer = null;
  function showToast(msg) {
    const toast = document.getElementById("toast");
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  /* ==================================================
     INIT
     ================================================== */
  loadLocal();
  applyStateToForm();
  refreshConditionalBlocks();
  updateSummary();
  goToStep(currentStep);
})();
