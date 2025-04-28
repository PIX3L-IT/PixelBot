require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { google }                   = require('googleapis');
const cron                         = require('node-cron');

// 0) Tu mapa de nombres a IDs de Discord
// mappings.json:
// {
//   "Maria": "123456789012345678",
//   "Juan":  "234567890123456789",
//   "Pepe":  "345678901234567890"
// }
const nameToId = require('./mappings.json');

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  GOOGLE_SPREADSHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
  SHEET_RANGE,    // ej. "Actividades!B2:N"
  TIMEZONE,       // "America/Mexico_City"
  CRON_SCHEDULE   // "0 8 * * *"
} = process.env;

// 1) Inicializa cliente de Discord
const client = new Client({
  intents: [ GatewayIntentBits.Guilds ]
});

// 2) Lee la hoja y clasifica tareas de hoy y pendientes
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
  const filas = res.data.values || [];         // B2:N sin cabecera
  const hoy   = new Date(); hoy.setHours(0,0,0,0);

  const tasksToday   = [];
  const tasksPending = [];

  for (const row of filas) {
    // Asegura que row tenga al menos 13 celdas (B→N)
    while (row.length < 13) row.push('');

    // Fecha en I (idx 7) en formato DD/MM/YYYY
    const rawDate = row[7].trim();
    if (!rawDate) continue;
    const parts = rawDate.split('/');
    if (parts.length !== 3) continue;
    const [d, m, y] = parts.map(n => parseInt(n, 10));
    const fecha = new Date(y, m-1, d);
    fecha.setHours(0,0,0,0);

    // Actividad en B (idx 0)
    const actividad = row[0].trim();
    if (!actividad) continue;

    // Responsables en H (idx 6), separados por coma
    const rawEnc = row[6] || '';
    const nombres = rawEnc
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const encargadoIds = nombres
      .map(n => nameToId[n])
      .filter(Boolean);

    // Estado en N (idx 12)
    const estado = row[12].trim().toLowerCase();

    if (fecha.getTime() === hoy.getTime()) {
      tasksToday.push({ actividad, nombres, encargadoIds });
    } else if (fecha.getTime() < hoy.getTime() && estado === 'no realizado') {
      tasksPending.push({ actividad, nombres, encargadoIds, fecha });
    }
  }

  return { tasksToday, tasksPending };
}

// 3) Construye y envía el mensaje formateado
async function sendTareas() {
  try {
    const { tasksToday, tasksPending } = await fetchTareas();
    if (!tasksToday.length && !tasksPending.length) return;

    // ordenar pendientes
    tasksPending.sort((a, b) => a.fecha - b.fecha);

    const fechaLegible = new Date().toLocaleDateString('es-MX');
    const lines = [`📋 Actividades para ${fechaLegible}`];

    // Hoy
    for (const t of tasksToday) {
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

    // Pendientes
    if (tasksPending.length) {
      lines.push('⏳ Pendientes:');
      for (const t of tasksPending) {
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

    const canal = await client.channels.fetch(DISCORD_CHANNEL_ID);

    // Función que corta en trozos de <=2000 chars
    const chunks = [];
    let chunk = '';
    for (const line of lines) {
      // si al añadir esta línea superamos 2000, empezamos un nuevo chunk
      if ((chunk + '\n' + line).length > 2000) {
        chunks.push(chunk);
        chunk = line;
      } else {
        chunk = chunk ? chunk + '\n' + line : line;
      }
    }
    if (chunk) chunks.push(chunk);

    // envía cada chunk en secuencia
    for (const msg of chunks) {
      await canal.send({ content: msg });
    }

    console.log('Tareas enviadas en', chunks.length, 'mensajes');
  } catch (err) {
    console.error('Error al enviar tareas:', err);
  }
}


// 4) Al iniciar el bot, programa el cron
client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);
  cron.schedule(CRON_SCHEDULE, sendTareas, { timezone: TIMEZONE });
});

// 5) Login en Discord
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
