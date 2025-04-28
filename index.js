require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { google } = require('googleapis');
const cron = require('node-cron');

// 0) Tu mapa de nombres a IDs
// mappings.json debe tener algo como:
// { "Maria": "123…", "Juan": "456…", "Pedro": "789…" }
const nameToId = require('./mappings.json');

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  GOOGLE_SPREADSHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
  SHEET_RANGE,    // ej. "Actividades!B2:I"
  TIMEZONE,       // "America/Mexico_City"
  CRON_SCHEDULE   // "0 8 * * *"
} = process.env;

const client = new Client({
  intents: [ GatewayIntentBits.Guilds ]
});

// Lee el sheet y devuelve [{ actividad, encargadoIds: [...] }, …]
async function fetchTareasHoy() {
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    range: SHEET_RANGE
  });
  const filas = res.data.values || [];
  const hoy = new Date();
  hoy.setHours(0,0,0,0);

  const tareas = [];
  for (const row of filas) {
    while (row.length < 8) row.push('');
    // Fecha en DD/MM/YYYY en columna I (índice 7)
    const rawDate = row[7].trim();
    if (!rawDate) continue;
    const parts = rawDate.split('/');
    if (parts.length !== 3) continue;
    const [d, m, a] = parts.map(x => parseInt(x,10));
    const fecha = new Date(a, m-1, d);
    fecha.setHours(0,0,0,0);
    if (fecha.getTime() !== hoy.getTime()) continue;

    // Actividad en B (índice 0)
    const actividad = row[0].trim();
    if (!actividad) continue;

    // VARIOS nombres en H (índice 6), separados por comas
    const rawEncargados = row[6];
    const nombres = rawEncargados
      .split(',')
      .map(n => n.trim())
      .filter(Boolean);

    // Traducir nombres a IDs
    const encargadoIds = nombres
      .map(n => nameToId[n])
      .filter(Boolean);

    if (encargadoIds.length === 0) {
      console.warn(`⚠️ No encontré IDs para [${nombres.join(', ')}]`);
      continue;
    }

    tareas.push({ actividad, encargadoIds });
  }

  return tareas;
}

// Envía el mensaje con todos los responsables
async function sendTareas() {
  try {
    const tareas = await fetchTareasHoy();
    if (tareas.length === 0) return;

    const fechaLegible = new Date().toLocaleDateString('es-MX');
    const lines = tareas.map(({ actividad, encargadoIds }) => {
      const mentions = encargadoIds
        .map(id => `<@${id}>`)
        .join(', ');
      return `• ${actividad}: ${mentions}`;
    });

    const mensaje = `📋 **Actividades para ${fechaLegible}**\n` +
                    lines.join('\n');

    const canal = await client.channels.fetch(DISCORD_CHANNEL_ID);
    await canal.send({ content: mensaje });
    console.log('Tareas enviadas');
  } catch (err) {
    console.error('Error al enviar tareas:', err);
  }
}

client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);
  cron.schedule(CRON_SCHEDULE, sendTareas, { timezone: TIMEZONE });
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

client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);

  // 2) Programa el cronjob
  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      try {
        const canal = await client.channels.fetch(DISCORD_CHANNEL_ID);
        await canal.send(
          `<@647956788724891679> tqm ❤️`
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
