require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { google }                   = require('googleapis');
const cron                         = require('node-cron');
const nameToId                     = require('./mappings.json');

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  GOOGLE_SPREADSHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
  SHEET_RANGE,          // e.g. "Actividades!A2:N"
  TIMEZONE,             // "America/Mexico_City"
  CRON_SCHEDULE,        // "0 8 * * *"
  POCHARIA_SHEET_ID,
  POCHARIA_SHEET_RANGE, // e.g. "Construcción!C2:Q"
  POCHARIA_CHANNEL_ID,
  TUBOS_SHEET_ID,
  TUBOS_SHEET_RANGE,    // e.g. "Tubos!C2:Q"
  TUBOS_CHANNEL_ID
} = process.env;

// Grupos CMMI
const GROUPS = [
  "RM","PP","PMC","M&A","PPQA","CM","RD","TS","PI",
  "VER","VAL","OPF","OPD","OT","IPM","RKM","DAR","REQM","Departamento"
];
const groupMap = GROUPS.reduce((m, g) => {
  m[g.toUpperCase()] = g;
  return m;
}, {});

// Cliente Discord
const client = new Client({ intents: [ GatewayIntentBits.Guilds ] });

// Función genérica para extraer IDs buscándolos en el texto completo
function extractIdsFromCell(text) {
  const ids = [];
  for (const [name, id] of Object.entries(nameToId)) {
    if (text.includes(name)) {
      ids.push(id);
    }
  }
  return Array.from(new Set(ids));
}

// 1) Tareas departamento
async function fetchTareas() {
  const auth   = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res    = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    range: SHEET_RANGE
  });
  const filas = res.data.values || [];
  const hoy   = new Date(); hoy.setHours(0,0,0,0);

  const tasksToday = [];
  const tasksPending = [];

  for (const row of filas) {
    while (row.length < 14) row.push('');
    const codeCell   = row[0].trim();
    const firstWord  = codeCell.split(' ')[0] || '';
    const groupKey   = firstWord.toUpperCase();
    const group      = groupMap[groupKey] || 'Otros';

    const actividad  = row[1].trim();
    if (!actividad) continue;

    // Extraer IDs sin importar comas ni separadores
    const rawEnc     = row[7] || '';
    const encargadoIds = extractIdsFromCell(rawEnc);

    const rawDate    = row[8].trim();
    if (!rawDate) continue;
    const parts      = rawDate.split('/');
    if (parts.length !== 3) continue;
    const [d,m,y]    = parts.map(n => parseInt(n,10));
    const fecha      = new Date(y, m-1, d);
    fecha.setHours(0,0,0,0);

    const estado     = (row[13] || '').trim().toLowerCase();

    if (fecha.getTime() === hoy.getTime() && estado === 'no realizado') {
      tasksToday.push({ group, actividad, encargadoIds });
    } else if (fecha.getTime() < hoy.getTime() && estado === 'no realizado') {
      tasksPending.push({ group, actividad, encargadoIds, fecha });
    }
  }

  return { tasksToday, tasksPending };
}

async function sendTareas() {
  try {
    const { tasksToday, tasksPending } = await fetchTareas();
    if (!tasksToday.length && !tasksPending.length) return;

    tasksPending.sort((a,b) => a.fecha - b.fecha);

    const fechaLegible = new Date().toLocaleDateString('es-MX');
    const lines = [`📋 Actividades para ${fechaLegible}`];

    // Hoy
    for (const group of [...GROUPS, 'Otros']) {
      const hoyGroup = tasksToday.filter(t => t.group === group);
      if (!hoyGroup.length) continue;
      lines.push(`**${group}**`);
      for (const t of hoyGroup) {
        const mentions = t.encargadoIds.length
          ? t.encargadoIds.map(id => `<@${id}>`).join(', ')
          : 'SIN ASIGNAR';
        lines.push(`• ${t.actividad}: ${mentions}`);
      }
    }
    // Pendientes
    if (tasksPending.length) {
      lines.push('⏳ Pendientes:');
      for (const group of [...GROUPS, 'Otros']) {
        const pendGroup = tasksPending.filter(t => t.group === group);
        if (!pendGroup.length) continue;
        lines.push(`**${group}**`);
        for (const t of pendGroup) {
          const mentions = t.encargadoIds.length
            ? t.encargadoIds.map(id => `<@${id}>`).join(', ')
            : 'SIN ASIGNAR';
          const fechaAnt = t.fecha.toLocaleDateString('es-MX');
          lines.push(`• ${t.actividad}: ${mentions} - ${fechaAnt}`);
        }
      }
    }

    const canal = await client.channels.fetch(DISCORD_CHANNEL_ID);
    const chunks = [];
    let chunk = '';
    for (const l of lines) {
      if ((chunk + '\n' + l).length > 2000) {
        chunks.push(chunk);
        chunk = l;
      } else {
        chunk = chunk ? chunk + '\n' + l : l;
      }
    }
    if (chunk) chunks.push(chunk);
    for (const msg of chunks) await canal.send({ content: msg });
    console.log('Tareas enviadas en', chunks.length, 'mensajes');
  } catch (err) {
    console.error('Error en sendTareas:', err);
  }
}

// 2) Pocharia (similar, sin agrupar)
async function fetchPocharia() {
  const auth   = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res    = await sheets.spreadsheets.values.get({
    spreadsheetId: POCHARIA_SHEET_ID,
    range: POCHARIA_SHEET_RANGE
  });
  const filas = res.data.values || [];
  const hoy   = new Date(); hoy.setHours(0,0,0,0);

  const today = [], pending = [];
  for (const row of filas) {
    while (row.length < 15) row.push('');
    const actividad = row[0].trim();
    if (!actividad) continue;

    const rawEnc    = row[6] || '';
    const ids       = extractIdsFromCell(rawEnc);

    const parts     = row[8].trim().split('/');
    if (parts.length !== 3) continue;
    const [d,m,y]   = parts.map(n=>parseInt(n,10));
    const fecha     = new Date(y,m-1,d);
    fecha.setHours(0,0,0,0);

    const estado    = row[14].trim().toLowerCase();
    if (fecha.getTime() === hoy.getTime() && estado === 'no realizado') {
      today.push({ actividad, ids });
    } else if (fecha.getTime() < hoy.getTime() && estado === 'no realizado') {
      pending.push({ actividad, ids, fecha });
    }
  }
  return { today, pending };
}

async function sendPocharia() {
  try {
    const { today, pending } = await fetchPocharia();
    if (!today.length && !pending.length) return;

    pending.sort((a,b) => a.fecha - b.fecha);
    const fechaLegible = new Date().toLocaleDateString('es-MX');
    const lines = [`📋 Actividades Pocharia para ${fechaLegible}`];

    for (const t of today) {
      const mentions = t.ids.length
        ? t.ids.map(id => `<@${id}>`).join(', ')
        : 'SIN ASIGNAR';
      lines.push(`• ${t.actividad}: ${mentions}`);
    }
    if (pending.length) {
      lines.push('⏳ Pendientes:');
      for (const t of pending) {
        const mentions = t.ids.length
          ? t.ids.map(id => `<@${id}>`).join(', ')
          : 'SIN ASIGNAR';
        const fechaAnt = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• ${t.actividad}: ${mentions} - ${fechaAnt}`);
      }
    }

    const canal = await client.channels.fetch(POCHARIA_CHANNEL_ID);
    const chunks = [], max = 2000;
    let chunk = '';
    for (const l of lines) {
      if ((chunk + '\n' + l).length > max) {
        chunks.push(chunk);
        chunk = l;
      } else {
        chunk = chunk ? chunk + '\n' + l : l;
      }
    }
    if (chunk) chunks.push(chunk);
    for (const msg of chunks) await canal.send({ content: msg });
    console.log('Pocharia enviada en', chunks.length, 'mensajes');
  } catch (err) {
    console.error('Error en sendPocharia:', err);
  }
}

// 3) Tubos (idéntico a Pocharia)
async function fetchTubos() {
  const auth   = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res    = await sheets.spreadsheets.values.get({
    spreadsheetId: TUBOS_SHEET_ID,
    range: TUBOS_SHEET_RANGE
  });
  const filas = res.data.values || [];
  const hoy   = new Date(); hoy.setHours(0,0,0,0);

  const today = [], pending = [];
  for (const row of filas) {
    while (row.length < 15) row.push('');
    const actividad = row[0].trim();
    if (!actividad) continue;

    const rawEnc    = row[6] || '';
    const ids       = extractIdsFromCell(rawEnc);

    const parts     = row[8].trim().split('/');
    if (parts.length !== 3) continue;
    const [d,m,y]   = parts.map(n=>parseInt(n,10));
    const fecha     = new Date(y,m-1,d);
    fecha.setHours(0,0,0,0);

    const estado    = row[14].trim().toLowerCase();
    if (fecha.getTime() === hoy.getTime() && estado === 'no realizado') {
      today.push({ actividad, ids });
    } else if (fecha.getTime() < hoy.getTime() && estado === 'no realizado') {
      pending.push({ actividad, ids, fecha });
    }
  }
  return { today, pending };
}

async function sendTubos() {
  try {
    const { today, pending } = await fetchTubos();
    if (!today.length && !pending.length) return;

    pending.sort((a,b) => a.fecha - b.fecha);
    const fechaLegible = new Date().toLocaleDateString('es-MX');
    const lines = [`📋 Actividades Tubos para ${fechaLegible}`];

    for (const t of today) {
      const mentions = t.ids.length
        ? t.ids.map(id => `<@${id}>`).join(', ')
        : 'SIN ASIGNAR';
      lines.push(`• ${t.actividad}: ${mentions}`);
    }
    if (pending.length) {
      lines.push('⏳ Pendientes:');
      for (const t of pending) {
        const mentions = t.ids.length
          ? t.ids.map(id => `<@${id}>`).join(', ')
          : 'SIN ASIGNAR';
        const fechaAnt = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• ${t.actividad}: ${mentions} - ${fechaAnt}`);
      }
    }

    const canal = await client.channels.fetch(TUBOS_CHANNEL_ID);
    const chunks = [], max = 2000;
    let chunk = '';
    for (const l of lines) {
      if ((chunk + '\n' + l).length > max) {
        chunks.push(chunk);
        chunk = l;
      } else {
        chunk = chunk ? chunk + '\n' + l : l;
      }
    }
    if (chunk) chunks.push(chunk);
    for (const msg of chunks) await canal.send({ content: msg });
    console.log('Tubos enviada en', chunks.length, 'mensajes');
  } catch (err) {
    console.error('Error en sendTubos:', err);
  }
}

// 4) Cron al iniciar
client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);
  cron.schedule(CRON_SCHEDULE, async () => {
    await sendTareas();
    await sendPocharia();
    await sendTubos();
  }, { timezone: TIMEZONE });
});

// 5) Login
client.login(DISCORD_TOKEN);











/* require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const cron = require('node-cron');


// Variables desde .env
const {
  DISCORD_TOKEN,      // Token de tu bot
  DISCORD_CHANNEL_ID, // ID del canal donde enviar el mensaje
  CRON_SCHEDULE,      // Ej: '0 8 * * *'
  TIMEZONE            // Ej: 'America/Mexico_City'
} = process.env;

// 1) Inicializa cliente de Discord
const client = new Client({
  intents: [ GatewayIntentBits.Guilds ]
});

const gifUrl = 'https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif';

client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);

  // 2) Programa el cronjob
  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      try {
        const canal = await client.channels.fetch(DISCORD_CHANNEL_ID);
        await canal.send(
          `<@1247721603987669044> ya paga la manutención `
        );
        console.log('Mensaje de prueba enviado.');
      } catch (err) {
        console.error('Error al enviar el mensaje de prueba:', err);
      }
    },
    { timezone: TIMEZONE }
  );
});

// 3) Inicia sesión
client.login(DISCORD_TOKEN);
  */


/* await canal.send({
  content: '¡Aquí va un GIF de celebración!',
  embeds: [{
    image: { url: gifUrl }
  }]
}); */