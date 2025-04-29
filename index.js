require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { google }                   = require('googleapis');
const cron                         = require('node-cron');
const nameToId                     = require('./mappings.json');

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  // Departamento
  GOOGLE_SPREADSHEET_ID,
  SHEET_RANGE,         // "Actividades!A2:N"
  // Pocharia
  POCHARIA_SHEET_ID,
  POCHARIA_SHEET_RANGE,
  POCHARIA_CHANNEL_ID,
  // Tubos
  TUBOS_SHEET_ID,
  TUBOS_SHEET_RANGE,
  TUBOS_CHANNEL_ID,
  // Fisio
  FISIO_SHEET_ID,
  FISIO_SHEET_RANGE,
  FISIO_CHANNEL_ID,
  // Credenciales + Cron
  GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
  TIMEZONE,
  CRON_SCHEDULE
} = process.env;

const client = new Client({ intents: [ GatewayIntentBits.Guilds ] });

// Lista de áreas CMMI
const CMMI_AREAS = [
  "RM","PP","PMC","M&A","PPQA","CM","RD","TS","PI",
  "VER","VAL","OPF","OPD","OT","IPM","RKM","DAR","REQM","Departamento"
];

// Justo después de cargar mappings.json:
const sortedNames = Object.keys(nameToId)
  .sort((a, b) => b.length - a.length);  // nombres de mayor a menor longitud

function extractIdsFromCell(text) {
  let remaining = text;
  const ids = [];

  for (const name of sortedNames) {
    const idx = remaining.indexOf(name);
    if (idx !== -1) {
      ids.push(nameToId[name]);
      // Eliminamos esa ocurrencia para no volver a casarla
      remaining = remaining.slice(0, idx)
                + remaining.slice(idx + name.length);
    }
  }

  // Devolvemos únicos
  return Array.from(new Set(ids));
}


// Función para enviar con el "viejo formato" agrupado por CMMI
async function sendDepartment() {
  // 1) Leer toda la tabla A→N
  const auth   = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res    = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    range: SHEET_RANGE            // debe incluir columna A
  });
  const rows = res.data.values || [];
  const todayDate = new Date(); todayDate.setHours(0,0,0,0);

  // 2) Clasificar en tasksToday y tasksPending con campo .group
  const tasksToday = [];
  const tasksPending = [];
  for (const row of rows) {
    // Aseguramos A→N
    while (row.length < 14) row.push('');
    const codeCell  = row[0].trim();
    const firstWord = codeCell.split(' ')[0].toUpperCase();
    const group     = CMMI_AREAS.includes(firstWord) ? firstWord : 'Departamento';

    const actividad = row[1].trim();
    if (!actividad) continue;

    const ids = extractIdsFromCell(row[7] || '');
    const parts = (row[8]||'').trim().split('/');
    if (parts.length !== 3) continue;
    const [d,m,y] = parts.map(n=>parseInt(n,10));
    const fecha = new Date(y,m-1,d); fecha.setHours(0,0,0,0);

    const estado = (row[13]||'').trim().toLowerCase();
    if (estado !== 'no realizado') continue;

    const task = { group, actividad, ids, fecha };

    if (fecha.getTime() === todayDate.getTime()) {
      tasksToday.push(task);
    } else if (fecha < todayDate) {
      tasksPending.push(task);
    }
  }

  // 3) Construir líneas con el viejo formato
  const fechaLegible = new Date().toLocaleDateString('es-MX');
  const lines = [
    `📋 **Actividades para ${fechaLegible}**`,
    ''
  ];

  // HOY (áreas en negritas)
  for (const area of CMMI_AREAS) {
    const items = tasksToday.filter(t => t.group === area);
    if (!items.length) continue;
    lines.push(`**${area}**`);      // <-- ahora en negritas
    for (const t of items) {
      const mentions = t.ids.length
        ? t.ids.map(id => `<@${id}>`).join(', ')
        : 'SIN ASIGNAR';
      lines.push(`• ${t.actividad}: ${mentions}`);
    }
    lines.push('');
  }

  // PENDIENTES (áreas en negritas)
  if (tasksPending.length) {
    lines.push('⏳ **Pendientes:**', '');
    for (const area of CMMI_AREAS) {
      const items = tasksPending.filter(t => t.group === area);
      if (!items.length) continue;
      lines.push(`**${area}**`);    // <-- también en negritas
      for (const t of items) {
        const mentions = t.ids.length
          ? t.ids.map(id => `<@${id}>`).join(', ')
          : 'SIN ASIGNAR';
        const ds = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• ${t.actividad}: ${mentions} - ${ds}`);
      }
      lines.push('');
    }
  }

  // 4) Envío en trozos ≤ 2000 chars
  const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
  let chunk = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > 2000) {
      await ch.send(chunk);
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }
  if (chunk) await ch.send(chunk);
}

// Función genérica para Pocharia, Tubos y Fisio (agrupa por persona)
async function sendGeneric(title, sheetId, range, colAct, colEnc, colDate, colStatus, channelId) {
  const auth   = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res    = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const rows   = res.data.values || [];
  const todayDate = new Date(); todayDate.setHours(0,0,0,0);

  const today   = [];
  const pending = [];
  for (const row of rows) {
    while (row.length <= Math.max(colAct, colEnc, colDate, colStatus)) row.push('');
    const actividad = row[colAct].trim();
    if (!actividad) continue;

    const ids = extractIdsFromCell(row[colEnc] || '');
    const parts = (row[colDate].trim()||'').split('/');
    if (parts.length !== 3) continue;
    const [d,m,y] = parts.map(n=>parseInt(n,10));
    const fecha = new Date(y,m-1,d); fecha.setHours(0,0,0,0);

    const estado = (row[colStatus]||'').trim().toLowerCase();
    if (estado !== 'no realizado') continue;

    const task = { actividad, ids, fecha };
    if (fecha.getTime() === todayDate.getTime()) today.push(task);
    else if (fecha < todayDate) pending.push(task);
  }
  pending.sort((a,b)=>a.fecha - b.fecha);

  const fechaLegible = new Date().toLocaleDateString('es-MX');
  const header = `📋 **${title} — ${fechaLegible}**`;
  const lines  = [ header, '' ];

  // helper
  const groupByIds = arr => {
    const m = new Map();
    for (const t of arr) {
      const key = t.ids.length
        ? t.ids.map(id=>`<@${id}>`).join(', ')
        : 'SIN_ASIGNAR';
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(t);
    }
    return m;
  };

  // Hoy
  const mapHoy = groupByIds(today);
  for (const [key, tasks] of mapHoy) {
    const titleKey = key === 'SIN_ASIGNAR' ? '**SIN ASIGNAR**' : key;
    lines.push(titleKey);
    for (const t of tasks) {
      lines.push(`• ${t.actividad}`);
    }
    lines.push('');
  }

  // Pendientes
  if (pending.length) {
    lines.push('⌛ **Pendientes:**', '');
    const mapPen = groupByIds(pending);
    for (const [key, tasks] of mapPen) {
      const titleKey = key === 'SIN_ASIGNAR' ? '**SIN ASIGNAR**' : key;
      lines.push(titleKey);
      for (const t of tasks) {
        const ds = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• ${t.actividad} — ${ds}`);
      }
      lines.push('');
    }
  }

  const ch = await client.channels.fetch(channelId);
  let chunk = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > 2000) {
      await ch.send(chunk);
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }
  if (chunk) await ch.send(chunk);
}

client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);
  cron.schedule(CRON_SCHEDULE, async () => {
    await sendDepartment();

    await sendGeneric(
      'Actividades Pocharia',
      POCHARIA_SHEET_ID, POCHARIA_SHEET_RANGE,
      0, 6, 8, 14,
      POCHARIA_CHANNEL_ID
    );

    await sendGeneric(
      'Actividades Tubos',
      TUBOS_SHEET_ID, TUBOS_SHEET_RANGE,
      0, 6, 8, 14,
      TUBOS_CHANNEL_ID
    );

    await sendGeneric(
      'Actividades Fisio',
      FISIO_SHEET_ID, FISIO_SHEET_RANGE,
      0, 8, 10, 16,
      FISIO_CHANNEL_ID
    );
  }, { timezone: TIMEZONE });
});

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