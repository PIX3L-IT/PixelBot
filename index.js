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
  SHEET_RANGE,         // e.g. "Actividades!A2:N"
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

// Grupos CMMI en orden (incluye "Departamento" al final)
const GROUPS = [
  "RM","PP","PMC","M&A","PPQA","CM","RD","TS","PI",
  "VER","VAL","OPF","OPD","OT","IPM","RKM","DAR","REQM","Departamento"
];

// Extrae todos los IDs cuyo nombre aparece en el texto
function extractIdsFromCell(text) {
  const ids = [];
  for (const [name, id] of Object.entries(nameToId)) {
    if (text.includes(name)) ids.push(id);
  }
  return [...new Set(ids)];
}

// Helper genérico para Pocharia, Tubos y Fisio
async function sendGeneric(title, sheetId, range, colAct, colEnc, colDate, colStatus, channelId) {
  // igual que antes...
  const auth   = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
    scopes:  ['https://www.googleapis.com/auth/spreadsheets.readonly']
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
    const ids = extractIdsFromCell(row[colEnc]||'');
    const parts = (row[colDate].trim()||'').split('/');
    if (parts.length !== 3) continue;
    const [d,m,y] = parts.map(n=>parseInt(n,10));
    const fecha = new Date(y,m-1,d); fecha.setHours(0,0,0,0);
    const estado = (row[colStatus]||'').trim().toLowerCase();
    if (estado !== 'no realizado') continue;
    if (fecha.getTime() === todayDate.getTime()) today.push({ actividad, ids, fecha });
    else if (fecha < todayDate) pending.push({ actividad, ids, fecha });
  }
  pending.sort((a,b)=>a.fecha - b.fecha);

  const fechaLegible = new Date().toLocaleDateString('es-MX');
  const header = `📋 **${title} — ${fechaLegible}**`;
  const lines  = [ header, '' ];

  // Función para agrupar por IDs
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
    const titleKey = key === 'SIN_ASIGNAR'
      ? '**SIN ASIGNAR**'
      : key;
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
      const titleKey = key === 'SIN_ASIGNAR'
        ? '**SIN ASIGNAR**'
        : key;
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
  for (const l of lines) {
    if ((chunk + '\n' + l).length > 2000) {
      await ch.send(chunk);
      chunk = l;
    } else {
      chunk = chunk ? `${chunk}\n${l}` : l;
    }
  }
  if (chunk) await ch.send(chunk);
}


// ——— Sección DEPARTAMENTO con tu viejo formato ———
async function sendDepartment() {
  // 1) Leemos toda la pestaña A→N
  const auth   = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
    scopes:  ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res    = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    range: SHEET_RANGE                 // debe incluir A2:N
  });
  const rows = res.data.values || [];
  const todayDate = new Date(); todayDate.setHours(0,0,0,0);

  // 2) Clasificamos por grupo, hoy y pendientes
  const tasksToday   = [];
  const tasksPending = [];
  for (const row of rows) {
    while (row.length < 14) row.push('');
    const codeCell  = row[0].trim();
    const grpKey    = codeCell.split(' ')[0].toUpperCase();
    const group     = GROUPS.includes(grpKey) ? grpKey : 'Departamento';

    const actividad = row[1].trim();
    if (!actividad) continue;

    const ids = extractIdsFromCell(row[7]||'');
    const parts = (row[8].trim()||'').split('/');
    if (parts.length !== 3) continue;
    const [d,m,y] = parts.map(n=>parseInt(n,10));
    const fecha = new Date(y,m-1,d); fecha.setHours(0,0,0,0);
    const estado = (row[13]||'').trim().toLowerCase();
    if (estado !== 'no realizado') continue;

    const obj = { group, actividad, ids, fecha };
    if (fecha.getTime() === todayDate.getTime()) tasksToday.push(obj);
    else if (fecha < todayDate)                  tasksPending.push(obj);
  }

  // 3) Armar líneas
  const fechaLegible = new Date().toLocaleDateString('es-MX');
  const lines = [
    `📋 **Actividades para ${fechaLegible}**`,
    ''
  ];

  // HOY
  for (const grp of GROUPS) {
    const items = tasksToday.filter(t => t.group === grp);
    if (!items.length) continue;
    lines.push(grp);
    for (const t of items) {
      const ment = t.ids.length
        ? t.ids.map(id=>`<@${id}>`).join(', ')
        : 'SIN ASIGNAR';
      lines.push(`• ${t.actividad}: ${ment}`);
    }
    lines.push('');
  }

  // PENDIENTES
  if (tasksPending.length) {
    lines.push('⏳ Pendientes:', '');
    for (const grp of GROUPS) {
      const items = tasksPending.filter(t => t.group === grp);
      if (!items.length) continue;
      lines.push(grp);
      for (const t of items) {
        const ment = t.ids.length
          ? t.ids.map(id=>`<@${id}>`).join(', ')
          : 'SIN ASIGNAR';
        const ds = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• ${t.actividad}: ${ment} - ${ds}`);
      }
      lines.push('');
    }
  }

  // 4) Enviar en chunks
  const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
  let chunk = '';
  for (const l of lines) {
    if ((chunk + '\n' + l).length > 2000) {
      await ch.send(chunk);
      chunk = l;
    } else {
      chunk = chunk ? `${chunk}\n${l}` : l;
    }
  }
  if (chunk) await ch.send(chunk);
}

// ——— Cron y arranque ———
client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);
  cron.schedule(CRON_SCHEDULE, async () => {
    await sendDepartment();
    await sendGeneric(
      'Actividades Pocharia',
      POCHARIA_SHEET_ID, POCHARIA_SHEET_RANGE,
      0,6,8,14, POCHARIA_CHANNEL_ID
    );
    await sendGeneric(
      'Actividades Tubos',
      TUBOS_SHEET_ID, TUBOS_SHEET_RANGE,
      0,6,8,14, TUBOS_CHANNEL_ID
    );
    await sendGeneric(
      'Actividades Fisio',
      FISIO_SHEET_ID, FISIO_SHEET_RANGE,
      0,8,10,16, FISIO_CHANNEL_ID
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