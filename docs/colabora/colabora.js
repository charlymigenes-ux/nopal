(function () {
  "use strict";

  /* ==================================================
     IDIOMA
     Se decide con el atributo lang del <html>: la version en espanol
     vive en /colabora/ y la inglesa en /colabora/en/. Ambas comparten
     este mismo archivo; aqui solo cambia el TEXTO, nunca la logica.
     ================================================== */
  const LANG = (document.documentElement.lang || "es").toLowerCase().indexOf("en") === 0 ? "en" : "es";

  const I18N = {
    es: {
      errStep2Type: "Selecciona el tipo de equipo para continuar.",
      errStep2Brand: "Indica la marca del equipo para continuar.",
      errStep2Model: "Indica el modelo o un nombre/descripci\u00f3n del equipo para continuar.",
      confirmClear: "\u00bfBorrar todo el progreso del formulario?",
      toastCleared: "Formulario borrado.",
      toastDemo: "Modo demo: revisa la consola del navegador.",
      toastSent: "\u00a1Registro enviado! Gracias por colaborar.",
      demoNotice: "<b>MODO DEMO:</b> este formulario todav\u00eda no est\u00e1 conectado a ning\u00fan servidor. " +
        "Tu registro <b>no fue enviado</b>. Se gener\u00f3 el objeto completo y puedes verlo abierto en la consola del navegador (F12).",
      errorLabel: "Error",
      errCompress: "No se pudo comprimir la imagen.",
      errRead: "No se pudo leer la imagen.",
      errUpload: "No se pudo subir la foto",
      errSubmit: "No se pudo enviar el registro",
      labels: {
        equipmentType: {
          impresora3d: "Impresora 3D", laser: "L\u00e1ser", cnc: "CNC / Router",
          placa: "Placa electr\u00f3nica", "esp-arduino": "ESP32 / ESP8266 / Arduino",
          accesorio: "Accesorio", otro: "Otro"
        },
        status: {
          funciona: "\ud83d\udfe2 Funciona correctamente", parcial: "\ud83d\udfe1 Funciona parcialmente",
          falla: "\ud83d\udd34 Tiene una falla", "no-enciende": "\u26ab No enciende",
          reemplazada: "\ud83d\udd35 Fue reemplazada pero la conservo", "no-seguro": "\u2753 No estoy seguro"
        },
        problems: {
          usb: "USB", drivers: "Drivers", motores: "Motores", temperaturas: "Temperaturas",
          calentadores: "Calentadores", pantalla: "Pantalla", wifi: "Wi-Fi", ethernet: "Ethernet",
          firmware: "Firmware", arranque: "Arranque", alimentacion: "Alimentaci\u00f3n",
          comunicacion: "Comunicaci\u00f3n", sensores: "Sensores", conectores: "Conectores",
          "da\u00f1o-fisico": "Da\u00f1o f\u00edsico", otro: "Otro"
        },
        participation: {
          tester: "\ud83e\uddea Tester", fallas: "\u26a0\ufe0f Reporta falla", donar: "\u2764\ufe0f Donaci\u00f3n",
          prestar: "\ud83e\udd1d Pr\u00e9stamo", vender: "\ud83c\udff7\ufe0f Venta", remoto: "\ud83d\udcbb Pruebas remotas",
          tecnico: "\ud83d\udee0\ufe0f T\u00e9cnico", info: "\u2139\ufe0f Solo informaci\u00f3n"
        }
      }
    },
    en: {
      errStep2Type: "Select the equipment type to continue.",
      errStep2Brand: "Enter the equipment brand to continue.",
      errStep2Model: "Enter the model or a custom name/description to continue.",
      confirmClear: "Clear all form progress?",
      toastCleared: "Form cleared.",
      toastDemo: "Demo mode: check the browser console.",
      toastSent: "Registration sent. Thanks for collaborating!",
      demoNotice: "<b>DEMO MODE:</b> this form is not connected to a server yet. " +
        "Your registration <b>was not sent</b>. The full object was generated and you can inspect it in the browser console (F12).",
      errorLabel: "Error",
      errCompress: "Could not compress the image.",
      errRead: "Could not read the image.",
      errUpload: "Could not upload the photo",
      errSubmit: "Could not send the registration",
      labels: {
        equipmentType: {
          impresora3d: "3D printer", laser: "Laser", cnc: "CNC / Router",
          placa: "Control board", "esp-arduino": "ESP32 / ESP8266 / Arduino",
          accesorio: "Accessory", otro: "Other"
        },
        status: {
          funciona: "\ud83d\udfe2 Works correctly", parcial: "\ud83d\udfe1 Partially working",
          falla: "\ud83d\udd34 Has a fault", "no-enciende": "\u26ab Won\u2019t power on",
          reemplazada: "\ud83d\udd35 Replaced, but I still have it", "no-seguro": "\u2753 Not sure"
        },
        problems: {
          usb: "USB", drivers: "Drivers", motores: "Motors", temperaturas: "Temperatures",
          calentadores: "Heaters", pantalla: "Display", wifi: "Wi-Fi", ethernet: "Ethernet",
          firmware: "Firmware", arranque: "Boot", alimentacion: "Power",
          comunicacion: "Communication", sensores: "Sensors", conectores: "Connectors",
          "da\u00f1o-fisico": "Physical damage", otro: "Other"
        },
        participation: {
          tester: "\ud83e\uddea Tester", fallas: "\u26a0\ufe0f Reports a fault", donar: "\u2764\ufe0f Donation",
          prestar: "\ud83e\udd1d Loan", vender: "\ud83c\udff7\ufe0f Sale", remoto: "\ud83d\udcbb Remote testing",
          tecnico: "\ud83d\udee0\ufe0f Technical", info: "\u2139\ufe0f Info only"
        }
      }
    }
  };
  const T = I18N[LANG];

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
  const STORAGE_ENDPOINT = "https://vphmstxbejjcnwltrffa.supabase.co/storage/v1/object";
  const STORAGE_BUCKET = "collaboration-photos";

  /* Redimensiona a un máximo de 1600px de lado y comprime a JPEG ~80% —
     una foto de celular de varios MB queda en unos cientos de KB. */
  function compressImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
          else { width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob(blob => {
          URL.revokeObjectURL(url);
          if (blob) resolve(blob); else reject(new Error(T.errCompress));
        }, "image/jpeg", quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(T.errRead)); };
      img.src = url;
    });
  }

  async function uploadPhoto(file, path) {
    const blob = await compressImage(file, 1600, 0.8);
    const res = await fetch(STORAGE_ENDPOINT + "/" + STORAGE_BUCKET + "/" + path, {
      method: "POST",
      headers: {
        "apikey": FORM_CONFIG.apiKey,
        "Authorization": "Bearer " + FORM_CONFIG.apiKey,
        "Content-Type": "image/jpeg"
      },
      body: blob
    });
    if (!res.ok) throw new Error(T.errUpload + " (" + res.status + ").");
    return path;
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(16) + Math.random().toString(16).slice(2);
  }

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

  async function submitCollaboration(data, photoFiles) {
    const row = toSupabaseRow(data);

    if (!FORM_CONFIG.endpoint) {
      console.log("[NOPAL Colabora] MODO DEMO — no hay backend configurado. Payload que se enviaría (las fotos no se suben en modo demo):");
      console.log(row);
      return { demo: true };
    }

    const id = newId();
    row.id = id;

    if (photoFiles && photoFiles.equipment) {
      try {
        row.photo_equipment_path = await uploadPhoto(photoFiles.equipment, id + "/equipment.jpg");
      } catch (e) {
        console.warn("[NOPAL Colabora] No se pudo subir la foto del equipo:", e.message);
      }
    }
    if (photoFiles && photoFiles.board) {
      try {
        row.photo_board_path = await uploadPhoto(photoFiles.board, id + "/board.jpg");
      } catch (e) {
        console.warn("[NOPAL Colabora] No se pudo subir la foto de la placa:", e.message);
      }
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
      throw new Error(T.errSubmit + " (" + res.status + ") " + detail);
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

  // Fotos en memoria — NUNCA en localStorage. Se comprimen y suben a Supabase Storage recién al enviar.
  const photos = { equipment: null, board: null };

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
    ["dz-equipment-preview", "dz-board-preview"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    });
    document.getElementById("collab-form").reset();
    document.getElementById("f-quantity").value = 1;
    applyStateToForm();
    goToStep(1);
    updateSummary();
    showToast(T.toastCleared);
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
      const hasType = !!state.equipment.type;
      const hasBrand = state.equipment.brand.trim().length > 0;
      const hasModelOrName = state.equipment.model.trim().length > 0 || state.equipment.customName.trim().length > 0;
      const ok = hasType && hasBrand && hasModelOrName;
      let msg = "";
      if (!hasType) msg = T.errStep2Type;
      else if (!hasBrand) msg = T.errStep2Brand;
      else if (!hasModelOrName) msg = T.errStep2Model;
      const errEl = document.getElementById("err-step2");
      if (errEl) errEl.textContent = msg;
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
    if (confirm(T.confirmClear)) clearLocal();
  });

  /* ==================================================
     RESUMEN EN VIVO
     ================================================== */
  const LABELS = T.labels;

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
  function setupDropzone(zoneId, inputId, previewId, slot) {
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
      preview.innerHTML = "";
      const f = files[0];
      photos[slot] = f;
      renderThumb(f, () => { photos[slot] = null; });
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

  setupDropzone("dz-equipment", "dz-equipment-input", "dz-equipment-preview", "equipment");
  setupDropzone("dz-board", "dz-board-input", "dz-board-preview", "board");

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
      const result = await submitCollaboration(JSON.parse(JSON.stringify(state)), photos);
      if (result && result.demo) {
        notice.hidden = false;
        notice.innerHTML = T.demoNotice;
        showToast(T.toastDemo);
      } else {
        showToast(T.toastSent);
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (err) {
      notice.hidden = false;
      notice.innerHTML = "<b>" + T.errorLabel + ":</b> " + err.message;
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
