require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder
} = require('discord.js');
const { google } = require('googleapis');
const nameToId   = require('./mappings.json');

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  // Departamento
  GOOGLE_SPREADSHEET_ID,
  SHEET_RANGE,
  // Notaría
  NOTARIA_SHEET_ID,
  NOTARIA_SHEET_RANGE,
  NOTARIA_CHANNEL_ID,
  // Tubos
  TUBOS_SHEET_ID,
  TUBOS_SHEET_RANGE,
  TUBOS_CHANNEL_ID,
  // Fisio
  FISIO_SHEET_ID,
  FISIO_SHEET_RANGE,
  FISIO_CHANNEL_ID,
  // Credenciales
  GOOGLE_SERVICE_ACCOUNT_CREDENTIALS
} = process.env;

const client = new Client({ intents: [ GatewayIntentBits.Guilds ] });

/** ––––– Helpers compartidos ––––– **/

// Normalización & extracción de IDs
function normalize(str) {
  return str.normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
}
const sortedNames = Object.keys(nameToId).sort((a,b)=>b.length-a.length);
function extractIdsFromCell(text) {
  let rem = normalize(text);
  const ids = [];
  for (const name of sortedNames) {
    const norm = normalize(name);
    const re   = new RegExp(`\\b${norm}\\b`, 'i');
    const m    = re.exec(rem);
    if (m) {
      ids.push(nameToId[name]);
      rem = rem.slice(0,m.index) + rem.slice(m.index+norm.length);
    }
  }
  return [...new Set(ids)];
}

// Lectura genérica de Sheets para “hoy” y “pendientes”
async function fetchTasks(sheetId, range, colAct, colEnc, colDate, colStatus) {
  const auth   = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version:'v4', auth });
  const res    = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const rows   = res.data.values || [];
  const today0 = new Date(); today0.setHours(0,0,0,0);

  const today   = [];
  const pending = [];
  const future  = [];

  for (const row of rows) {
    while (row.length <= Math.max(colAct, colEnc, colDate, colStatus)) row.push('');
    const act = row[colAct].trim();
    if (!act) continue;
    const ids = extractIdsFromCell(row[colEnc]||'');
    const parts = (row[colDate]||'').split('/');
    if (parts.length!==3) continue;
    const [d,m,y] = parts.map(n=>parseInt(n,10));
    const fecha   = new Date(y,m-1,d); fecha.setHours(0,0,0,0);
    if ((row[colStatus]||'').trim().toLowerCase() !== 'no realizado') continue;

    const obj = { actividad: act, ids, fecha };
    if      (fecha.getTime() === today0.getTime()) today.push(obj);
    else if (fecha.getTime() <  today0.getTime()) pending.push(obj);
    else                                           future.push(obj);
  }

  pending.sort((a,b)=>a.fecha - b.fecha);
  future.sort((a,b)=>a.fecha - b.fecha);
  return { today, pending, future };
}

/** ––––– Sección “Departamento” (antiguo formato) ––––– **/

// Lista de grupos en orden
const GROUPS = [
  "RM","PP","PMC","MA","PPQA","CM","RD","TS","PI",
  "VER","VAL","OPF","OPD","OT","IPM","RKM","DAR","REQM","Departamento"
];
// Mapa de uppercase → nombre original
const groupMap = GROUPS.reduce((acc, g) => {
  acc[g.toUpperCase()] = g;
  return acc;
}, {});

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
  const tasksFuture  = [];

  for (const row of filas) {
    while (row.length < 14) row.push('');
    const codeCell = row[0].trim().split(' ')[0].toUpperCase();
    const group    = groupMap[codeCell] || 'Otros';
    const actividad = row[1].trim();
    if (!actividad) continue;

    const nombres      = (row[7]||'').split(',').map(n=>n.trim()).filter(Boolean);
    const encargadoIds = nombres.map(n=>nameToId[n]).filter(Boolean);
    const rawDate      = row[8].trim();
    if (!rawDate) continue;
    const [d,m,y] = rawDate.split('/').map(n=>parseInt(n,10));
    const fecha   = new Date(y,m-1,d); fecha.setHours(0,0,0,0);

    const estado = (row[13]||'').trim().toLowerCase();
    if (estado !== 'no realizado') continue;

    const obj = { group, actividad, nombres, encargadoIds, fecha };
    if      (fecha.getTime() === hoy.getTime()) tasksToday.push(obj);
    else if (fecha.getTime() <  hoy.getTime()) tasksPending.push(obj);
    else                                        tasksFuture.push(obj);
  }

  tasksPending.sort((a,b) => a.fecha - b.fecha);
  tasksFuture.sort((a,b)  => a.fecha - b.fecha);
  return { tasksToday, tasksPending, tasksFuture };
}

// 2) Construir y enviar el mensaje, con chunks ≤2000 chars
async function sendDepartment() {
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
          mentionText = 'Formato incorrecto (si son varios asignados, separarlos con comas)';
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
            mentionText = 'Formato incorrecto (si son varios asignados, separarlos con comas)';
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

/** ––––– Sección genérica para Notaría, Tubos y Fisio ––––– **/

async function sendGeneric(title, sheetId, range, colAct, colEnc, colDate, colStatus, channelId) {
  const { today, pending } = await fetchTasks(sheetId, range, colAct, colEnc, colDate, colStatus);
  if (!today.length && !pending.length) return;

  const fechaHoy = new Date().toLocaleDateString('es-MX');
  const lines = [`📋 **${title} — ${fechaHoy}**`, ''];

  const groupBy = arr => {
    const m = new Map();
    for (const t of arr) {
      const key = t.ids.length
        ? t.ids.map(i=>`<@${i}>`).join(', ')
        : 'SIN_ASIGNAR';
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(t);
    }
    return m;
  };

  // HOY: primero SIN_ASIGNAR
  const mapHoy = groupBy(today);
  if (mapHoy.has('SIN_ASIGNAR')) {
    lines.push('**SIN ASIGNAR**');
    for (const t of mapHoy.get('SIN_ASIGNAR')) {
      lines.push(`• ${t.actividad}`);
    }
    lines.push('');
  }
  for (const [key, tasks] of mapHoy) {
    if (key==='SIN_ASIGNAR') continue;
    lines.push(key);
    for (const t of tasks) lines.push(`• ${t.actividad}`);
    lines.push('');
  }

  // PENDIENTES: igual
  if (pending.length) {
    lines.push('⌛ **Pendientes:**','');
    const mapPen = groupBy(pending);
    if (mapPen.has('SIN_ASIGNAR')) {
      lines.push('**SIN ASIGNAR**');
      for (const t of mapPen.get('SIN_ASIGNAR')) {
        const ds = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• ${t.actividad} — ${ds}`);
      }
      lines.push('');
    }
    for (const [key, tasks] of mapPen) {
      if (key==='SIN_ASIGNAR') continue;
      lines.push(key);
      for (const t of tasks) {
        const ds = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• ${t.actividad} — ${ds}`);
      }
      lines.push('');
    }
  }

  // envío
  const ch = await client.channels.fetch(channelId);
  let chunk = '';
  for (const l of lines) {
    if ((chunk+'\n'+l).length > 2000) {
      await ch.send(chunk);
      chunk = l;
    } else {
      chunk = chunk ? `${chunk}\n${l}` : l;
    }
  }
  if (chunk) await ch.send(chunk);
}

// Nada más un área del CMMI
async function sendArea(area) {
  try {
    const { tasksToday, tasksPending } = await fetchTareas();
    // Filtrar sólo el área solicitada
    const hoyStr = new Date().toLocaleDateString('es-MX');
    const lines = [`📋 Actividades **${area}** para ${hoyStr}`, ''];

    // Tareas de hoy
    const hoy = tasksToday.filter(t => t.group === area);
    if (hoy.length) {
      for (const t of hoy) {
        const mention = t.encargadoIds.length
          ? t.encargadoIds.map(id => `<@${id}>`).join(', ')
          : (t.nombres.length ? 'Formato incorrecto' : 'SIN ASIGNAR');
        lines.push(`• ${t.actividad}: ${mention}`);
      }
    } else {
      lines.push('— No hay actividades para hoy —');
    }

    // Pendientes
    const pen = tasksPending.filter(t => t.group === area);
    if (pen.length) {
      lines.push('', '⏳ Pendientes:');
      for (const t of pen) {
        const mention = t.encargadoIds.length
          ? t.encargadoIds.map(id => `<@${id}>`).join(', ')
          : (t.nombres.length ? 'Formato incorrecto' : 'SIN ASIGNAR');
        const fecha = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• ${t.actividad}: ${mention} — ${fecha}`);
      }
    }

    // Partir en trozos ≤2000 caracteres
    const canal = await client.channels.fetch(DISCORD_CHANNEL_ID);
    let chunk = '';
    for (const line of lines) {
      if ((chunk + '\n' + line).length > 2000) {
        await canal.send(chunk);
        chunk = line;
      } else {
        chunk = chunk ? `${chunk}\n${line}` : line;
      }
    }
    if (chunk) await canal.send(chunk);

  } catch (err) {
    console.error(`Error al enviar área ${area}:`, err);
  }
}

/** ––––– Registrar comandos slash y manejarlos ––––– **/
client.once('ready', async () => {
  console.log(`Conectado como ${client.user.tag}`);

  // 1) Comando /send…
  const sendBuilder = new SlashCommandBuilder()
    .setName('send')
    .setDescription('Enviar manualmente las secciones')
    .addSubcommand(sub => sub.setName('departamento').setDescription('Envía actividades Departamento'))
    .addSubcommand(sub => sub.setName('notaria')    .setDescription('Envía actividades Notaría'))
    .addSubcommand(sub => sub.setName('tubos')       .setDescription('Envía actividades Tubos'))
    .addSubcommand(sub => sub.setName('fisio')       .setDescription('Envía actividades Fisio'))
    .addSubcommand(sub => sub.setName('all')         .setDescription('Envía todas las secciones'));
  for (const g of GROUPS) {
    if (g === 'Departamento') continue;
    sendBuilder.addSubcommand(sub =>
      sub.setName(g.toLowerCase())
         .setDescription(`Envía actividades ${g}`)
    );
  }

  // 2) Comando /pending…
  const pendingBuilder = new SlashCommandBuilder()
    .setName('misactividades')
    .setDescription('Recibe tus actividades por DM')
    .toJSON();

  // 3) Registramos ambos comandos (guild para test rápido, si existe)
  const commands = [
    sendBuilder.toJSON(),
    pendingBuilder
  ];
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (guild) {
    await guild.commands.set(commands);
    console.log('Slash commands (send + pending) registrados en guild.');
  } else {
    await client.application.commands.set(commands);
    console.log('Slash commands (send + pending) registrados globalmente.');
  }
});


/** ––––– Manejar interacciones ––––– **/
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // ——— /send ———
  if (interaction.commandName === 'send') {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    try {
      switch (sub) {
        case 'departamento':
          await sendDepartment();
          return void await interaction.editReply('✅ Departamento enviado.');
        case 'notaria':
          await sendGeneric('Actividades Notaría', NOTARIA_SHEET_ID, NOTARIA_SHEET_RANGE, 0,6,8,14, NOTARIA_CHANNEL_ID);
          return void await interaction.editReply('✅ Notaría enviado.');
        case 'tubos':
          await sendGeneric('Actividades Tubos', TUBOS_SHEET_ID, TUBOS_SHEET_RANGE, 0,6,8,14, TUBOS_CHANNEL_ID);
          return void await interaction.editReply('✅ Tubos enviado.');
        case 'fisio':
          await sendGeneric('Actividades Fisio', FISIO_SHEET_ID, FISIO_SHEET_RANGE, 0,8,10,16, FISIO_CHANNEL_ID);
          return void await interaction.editReply('✅ Fisio enviado.');
        case 'all':
          await sendDepartment();
          await sendGeneric('Actividades Notaría', NOTARIA_SHEET_ID, NOTARIA_SHEET_RANGE, 0,6,8,14, NOTARIA_CHANNEL_ID);
          await sendGeneric('Actividades Tubos',    TUBOS_SHEET_ID,   TUBOS_SHEET_RANGE,   0,6,8,14, TUBOS_CHANNEL_ID);
          await sendGeneric('Actividades Fisio',    FISIO_SHEET_ID,   FISIO_SHEET_RANGE,   0,8,10,16, FISIO_CHANNEL_ID);
          return void await interaction.editReply('✅ Todas las secciones enviadas.');
        default:
          if (GROUPS.map(g=>g.toLowerCase()).includes(sub)) {
            const area = groupMap[sub.toUpperCase()];
            await sendArea(area);
            return void await interaction.editReply(`✅ ${area} enviado.`);
          }
          return void await interaction.editReply('❌ Subcomando no reconocido.');
      }
    } catch (err) {
      console.error(err);
      await interaction.editReply('❌ Ocurrió un error al enviar.');
    }
  }

  // ——— /pending ———
  if (interaction.commandName === 'misactividades') {
    await interaction.deferReply({ ephemeral: true });
    try {
      await sendMyPending(interaction);
      await interaction.editReply('✅ Te envié tus actividades por DM.');
    } catch (err) {
      console.error(err);
      await interaction.editReply('❌ No pude enviar tus actividades.');
    }
  }
});


/** ––––– Función que toma un Interaction y DM al usuario sus tareas pendientes ––––– **/
/**
 * Envía por DM las actividades de hoy y las pendientes de la persona que invoca el comando.
 */
/**
 * Envía por DM las actividades de HOY y las PENDIENTES de la persona que invoca el comando.
 */
async function sendMyPending(interaction) {
  const userId = interaction.user.id;
  const lines  = [];

  // — HOY —
  lines.push('📋 **Tus actividades para HOY**','');
  let hasToday = false;

  const { tasksToday: deptToday, tasksPending: deptPending, tasksFuture: deptFuture } = await fetchTareas();
  const myDeptToday = deptToday.filter(t => t.encargadoIds.includes(userId));
  if (myDeptToday.length) {
    hasToday = true;
    lines.push('**Departamento**');
    myDeptToday.forEach(t => lines.push(`• ${t.actividad}`));
    lines.push('');
  }

  const genericConfigs = [
    ['Notaría', NOTARIA_SHEET_ID, NOTARIA_SHEET_RANGE, 0,6,8,14],
    ['Tubos',    TUBOS_SHEET_ID,   TUBOS_SHEET_RANGE,   0,6,8,14],
    ['Fisio',    FISIO_SHEET_ID,   FISIO_SHEET_RANGE,   0,8,10,16],
  ];
  for (const [title, sid, range, ca, ce, cd, cs] of genericConfigs) {
    const { today: genToday } = await fetchTasks(sid, range, ca, ce, cd, cs);
    const mineToday = genToday.filter(t => t.ids.includes(userId));
    if (mineToday.length) {
      hasToday = true;
      lines.push(`**${title}**`);
      mineToday.forEach(t => lines.push(`• ${t.actividad}`));
      lines.push('');
    }
  }

  if (!hasToday) lines.push('✅ No tienes actividades para hoy.','');

  // — PENDIENTES —
  lines.push('⌛ **Tus actividades PENDIENTES**','');
  let hasPending = false;

  const myDeptPend = deptPending.filter(t => t.encargadoIds.includes(userId));
  if (myDeptPend.length) {
    hasPending = true;
    lines.push('**Departamento**');
    myDeptPend.forEach(t => {
      const fecha = t.fecha.toLocaleDateString('es-MX');
      lines.push(`• [${fecha}] ${t.actividad}`);
    });
    lines.push('');
  }

  for (const [title, sid, range, ca, ce, cd, cs] of genericConfigs) {
    const { pending: genPend } = await fetchTasks(sid, range, ca, ce, cd, cs);
    const minePend = genPend.filter(t => t.ids.includes(userId));
    if (minePend.length) {
      hasPending = true;
      lines.push(`**${title}**`);
      minePend.forEach(t => {
        const fecha = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• [${fecha}] ${t.actividad}`);
      });
      lines.push('');
    }
  }

  if (!hasPending) lines.push('✅ ¡No tienes actividades pendientes!','');

  // — FUTURAS —
  lines.push('🤖 **Tus actividades FUTURAS**','');
  let hasFuture = false;

  const myDeptFuture = deptFuture.filter(t => t.encargadoIds.includes(userId));
  if (myDeptFuture.length) {
    hasFuture = true;
    lines.push('**Departamento**');
    myDeptFuture.forEach(t => {
      const fecha = t.fecha.toLocaleDateString('es-MX');
      lines.push(`• [${fecha}] ${t.actividad}`);
    });
    lines.push('');
  }

  for (const [title, sid, range, ca, ce, cd, cs] of genericConfigs) {
    const { future: genFuture } = await fetchTasks(sid, range, ca, ce, cd, cs);
    const mineFuture = genFuture.filter(t => t.ids.includes(userId));
    if (mineFuture.length) {
      hasFuture = true;
      lines.push(`**${title}**`);
      mineFuture.forEach(t => {
        const fecha = t.fecha.toLocaleDateString('es-MX');
        lines.push(`• [${fecha}] ${t.actividad}`);
      });
      lines.push('');
    }
  }

  if (!hasFuture) lines.push('✅ No tienes actividades en el futuro.');

  // — Enviar DM —
  await interaction.user.send(lines.join('\n'));
}



client.login(DISCORD_TOKEN);
