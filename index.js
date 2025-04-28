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
  SHEET_RANGE,    // ej. "Actividades!A2:N"
  TIMEZONE,       // "America/Mexico_City"
  CRON_SCHEDULE   // "0 8 * * *"
} = process.env;

// Lista de grupos en orden
const GROUPS = [
  "RM","PP","PMC","M&A","PPQA","CM","RD","TS","PI",
  "VER","VAL","OPF","OPD","OT","IPM","RKM","DAR","REQM","Departamento"
];
// Mapa de uppercase → nombre original
const groupMap = GROUPS.reduce((acc, g) => {
  acc[g.toUpperCase()] = g;
  return acc;
}, {});

// Inicializa el cliente de Discord
const client = new Client({
  intents: [ GatewayIntentBits.Guilds ]
});

// 1) Leer y clasificar tareas
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

  const tasksToday   = [];
  const tasksPending = [];

  for (const row of filas) {
    // Asegura que row tenga al menos 14 celdas (A→N)
    while (row.length < 14) row.push('');

    // 1. Grupo: primera palabra de columna A (idx 0)
    const codeCell = row[0].trim();
    const firstWord = codeCell.split(' ')[0] || '';
    const groupKey  = firstWord.toUpperCase();
    const group     = groupMap[groupKey] || 'Otros';

    // 2. Actividad: columna B (idx 1)
    const actividad = row[1].trim();
    if (!actividad) continue;

    // 3. Responsables: columna H (idx 7)
    const nombres = (row[7] || '')
      .split(',')
      .map(n => n.trim())
      .filter(Boolean);
    const encargadoIds = nombres
      .map(n => nameToId[n])
      .filter(Boolean);

    // 4. Fecha: columna I (idx 8) en DD/MM/YYYY
    const rawDate = row[8].trim();
    if (!rawDate) continue;
    const parts = rawDate.split('/');
    if (parts.length !== 3) continue;
    const [d, m, y] = parts.map(n => parseInt(n, 10));
    const fecha = new Date(y, m - 1, d);
    fecha.setHours(0,0,0,0);

    // 5. Estado: columna N (idx 13)
    const estado = (row[13] || '').trim().toLowerCase();

    // Clasifica
    if (fecha.getTime() === hoy.getTime()) {
      tasksToday.push({ group, actividad, nombres, encargadoIds });
    } else if (fecha.getTime() < hoy.getTime() && estado === 'no realizado') {
      tasksPending.push({ group, actividad, nombres, encargadoIds, fecha });
    }
  }

  return { tasksToday, tasksPending };
}

// 2) Construir y enviar el mensaje, con chunks ≤2000 chars
async function sendTareas() {
  try {
    const { tasksToday, tasksPending } = await fetchTareas();
    if (!tasksToday.length && !tasksPending.length) return;

    // Ordena pendientes de más antiguas a más recientes
    tasksPending.sort((a, b) => a.fecha - b.fecha);

    const fechaLegible = new Date().toLocaleDateString('es-MX');
    const lines = [`📋 Actividades para ${fechaLegible}`];

    // -- Sección: tareas de hoy, agrupadas
    for (const group of [...GROUPS, 'Otros']) {
      const grupoHoy = tasksToday.filter(t => t.group === group);
      if (!grupoHoy.length) continue;
      lines.push(`**${group}**`);
      for (const t of grupoHoy) {
        let mentionText;
        if (t.nombres.length === 0) {
          mentionText = 'SIN ASIGNAR';
        } else if (t.encargadoIds.length === 0) {
          mentionText = 'CHECAR PVG, FORMATO INCORRECTO';
        } else {
          mentionText = t.encargadoIds.map(id => `<@${id}>`).join(', ');
        }
        lines.push(`• ${t.actividad}: ${mentionText}`);
      }
    }

    // -- Sección: pendientes
    if (tasksPending.length) {
      lines.push('⏳ Pendientes:');
      for (const group of [...GROUPS, 'Otros']) {
        const grupoPend = tasksPending.filter(t => t.group === group);
        if (!grupoPend.length) continue;
        lines.push(`**${group}**`);
        for (const t of grupoPend) {
          let mentionText;
          if (t.nombres.length === 0) {
            mentionText = 'SIN ASIGNAR';
          } else if (t.encargadoIds.length === 0) {
            mentionText = 'CHECAR PVG, FORMATO INCORRECTO';
          } else {
            mentionText = t.encargadoIds.map(id => `<@${id}>`).join(', ');
          }
          const fechaAnt = t.fecha.toLocaleDateString('es-MX');
          lines.push(`• ${t.actividad}: ${mentionText} - ${fechaAnt}`);
        }
      }
    }

    // Partir en trozos de ≤2000 chars
    const canal = await client.channels.fetch(DISCORD_CHANNEL_ID);
    const chunks = [];
    let chunk = '';
    for (const line of lines) {
      if ((chunk + '\n' + line).length > 2000) {
        chunks.push(chunk);
        chunk = line;
      } else {
        chunk = chunk ? chunk + '\n' + line : line;
      }
    }
    if (chunk) chunks.push(chunk);

    // Enviar cada chunk
    for (const msg of chunks) {
      await canal.send({ content: msg });
    }
    console.log('Tareas enviadas en', chunks.length, 'mensajes');
  } catch (err) {
    console.error('Error al enviar tareas:', err);
  }
}

// 3) Programa el cron cuando el bot esté listo
client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);
  cron.schedule(CRON_SCHEDULE, sendTareas, { timezone: TIMEZONE });
});

// 4) Login
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


await canal.send({
  content: '¡Aquí va un GIF de celebración!',
  embeds: [{
    image: { url: gifUrl }
  }]
});