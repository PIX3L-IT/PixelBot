require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { google } = require('googleapis');
const cron = require('node-cron');

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  GOOGLE_SPREADSHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
  SHEET_RANGE,      // ej. "Actividades!B2:I"
  TIMEZONE,         // "America/Mexico_City"
  CRON_SCHEDULE     // "0 8 * * *"
} = process.env;

// 1) Inicializa el cliente de Discord
const client = new Client({
  intents: [ GatewayIntentBits.Guilds ]
});

// 2) Lee el sheet y devuelve array de objetos { actividad, encargadoId }
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
    // Asegura al menos 8 columnas para B→I
    while (row.length < 8) row.push('');
    const rawDate = row[7].trim();     // Columna I
    if (!rawDate) continue;

    const partes = rawDate.split('/');
    if (partes.length !== 3) continue;
    const [d, m, a] = partes.map(n => parseInt(n, 10));
    const fecha = new Date(a, m - 1, d);
    fecha.setHours(0,0,0,0);
    if (fecha.getTime() !== hoy.getTime()) continue;

    const actividad   = row[0].trim();  // Columna B
    const encargadoId = row[6].trim();  // Columna H

    if (actividad && encargadoId) {
      tareas.push({ actividad, encargadoId });
    }
  }

  return tareas;
}

// 3) Envía el mensaje mencionando a cada encargado
async function sendTareas() {
  try {
    const tareas = await fetchTareasHoy();
    if (tareas.length === 0) return;

    const fechaLegible = new Date().toLocaleDateString('es-MX');
    const lines = tareas.map(t =>
      `• <@${t.encargadoId}> ${t.actividad}`
    );

    const mensaje = `📋 **Actividades para ${fechaLegible}**\n` +
                    lines.join('\n');

    const canal = await client.channels.fetch(DISCORD_CHANNEL_ID);
    await canal.send({ content: mensaje });
    console.log('Tareas enviadas');
  } catch (err) {
    console.error('Error al enviar tareas:', err);
  }
}

// 4) Al conectar, programa el cron
client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);
  cron.schedule(CRON_SCHEDULE, sendTareas, { timezone: TIMEZONE });
});

// 5) Arranca el bot
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
