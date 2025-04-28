require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { google }               = require('googleapis');
const cron                     = require('node-cron');

// 0) Mapa de nombres a IDs de Discord
const nameToId = require('./mappings.json');

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  GOOGLE_SPREADSHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
  SHEET_RANGE,    // e.g. "Actividades!B2:N"
  TIMEZONE,       // "America/Mexico_City"
  CRON_SCHEDULE   // "0 8 * * *"
} = process.env;

// Cliente Discord
const client = new Client({
  intents: [ GatewayIntentBits.Guilds ]
});

// 1) Lee todas las filas relevantes y separa hoy / pendientes
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

  // sin cabecera
  const filas = (res.data.values || []).slice(0);
  const hoy   = new Date();
  hoy.setHours(0,0,0,0);

  const tasksToday = [];
  const tasksPending = [];

  for (const row of filas) {
    // B→N son 13 columnas
    while (row.length < 13) row.push('');

    // Columna I (idx 7): fecha DD/MM/YYYY
    const rawDate = row[7].trim();
    if (!rawDate) continue;
    const parts = rawDate.split('/');
    if (parts.length !== 3) continue;
    const [d, m, y] = parts.map(n => parseInt(n,10));
    const fecha = new Date(y, m-1, d);
    fecha.setHours(0,0,0,0);

    // Columna N (idx 12): estado
    const estado = row[12].trim().toLowerCase();

    // Columna B (idx 0): actividad
    const actividad = row[0].trim();
    if (!actividad) continue;

    // Columna H (idx 6): responsables, separados por comas
    const nombres = row[6]
      .split(',')
      .map(n => n.trim())
      .filter(Boolean);
    const encargadoIds = nombres
      .map(n => nameToId[n])
      .filter(Boolean);
    if (!encargadoIds.length) {
      console.warn(`⚠️ Sin ID para [${nombres.join(', ')}]`);
      continue;
    }

    // Clasificar
    if (fecha.getTime() === hoy.getTime()) {
      // solo tareas de hoy (independientemente de estado)
      tasksToday.push({ actividad, encargadoIds });
    } else if (fecha.getTime() < hoy.getTime() && estado === 'no realizado') {
      // tareas atrasadas y aún no hechas
      tasksPending.push({ actividad, encargadoIds, fecha });
    }
  }

  return { tasksToday, tasksPending };
}

// 2) Construye y envía el mensaje
async function sendTareas() {
  try {
    const { tasksToday, tasksPending } = await fetchTareas();
    if (!tasksToday.length && !tasksPending.length) return;

    const fechaLegible = new Date().toLocaleDateString('es-MX');
    const lines = [
      `**📋 Actividades para ${fechaLegible}**`
    ];

    // Hoy
    for (const t of tasksToday) {
      const mentions = t.encargadoIds.map(id => `<@${id}>`).join(', ');
      lines.push(`• ${t.actividad}: ${mentions}`);
    }

    // Pendientes
    if (tasksPending.length) {
      lines.push('**⏳ Actividades pendientes:**');
      for (const t of tasksPending) {
        const mentions = t.encargadoIds.map(id => `<@${id}>`).join(', ');
        const fechaAnt = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• ${t.actividad}: ${mentions} - ${fechaAnt}`);
      }
    }

    const mensaje = lines.join('\n');
    const canal   = await client.channels.fetch(DISCORD_CHANNEL_ID);
    await canal.send({ content: mensaje });
    console.log('Tareas enviadas');
  } catch (err) {
    console.error('Error al enviar tareas:', err);
  }
}

// 3) Al iniciar el bot, programa el cron
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
