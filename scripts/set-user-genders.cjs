// Asignaciones confirmadas por el usuario. Primero ejecutar sin --apply para revisar coincidencias.
// node scripts/set-user-genders.cjs --credentials <serviceAccountKey.json> [--apply]
const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');

const normalize = (name) => String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
const assignments = [
  { name: 'Jose Alfonso Corona', gender: 'male', matches: (name) => name === 'jose alfonso corona' || name === 'alfonso corona' },
  { name: 'Jazmin', gender: 'female', matches: (name) => name.split(' ')[0] === 'jazmin' },
  { name: 'Andrea', gender: 'female', matches: (name) => name.split(' ')[0] === 'andrea' },
];

async function main() {
  const credentialsIndex = process.argv.indexOf('--credentials');
  const credentialsPath = credentialsIndex >= 0 ? process.argv[credentialsIndex + 1] : process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsPath) throw Error('Falta --credentials <ruta> o GOOGLE_APPLICATION_CREDENTIALS.');
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  if (credentials.project_id !== 'base-mayorista') throw Error('Proyecto inesperado.');
  admin.initializeApp({ credential: admin.credential.cert(credentials) });
  const db = admin.firestore();
  const snapshot = await db.collection('users').select('displayName', 'display_name', 'gender').get();
  if (process.argv.includes('--inspect')) {
    for (const doc of snapshot.docs) {
      const name = doc.get('displayName') || doc.get('display_name');
      if (/jose|alfonso|corona|jazmin|andrea/.test(normalize(name))) console.log(JSON.stringify({ uid: doc.id, name, gender: doc.get('gender') ?? null }));
    }
    return;
  }
  const selected = assignments.map((assignment) => {
    const matches = snapshot.docs.filter((doc) => assignment.matches(normalize(doc.get('displayName') || doc.get('display_name'))));
    if (matches.length !== 1) throw Error(`${assignment.name}: ${matches.length} coincidencias; no se modificó ningún perfil.`);
    const doc = matches[0];
    return { uid: doc.id, name: doc.get('displayName') || doc.get('display_name'), before: doc.get('gender') ?? null, gender: assignment.gender, ref: doc.ref, updateTime: doc.updateTime };
  });
  console.log(JSON.stringify(selected.map(({ ref, updateTime, ...row }) => row), null, 2));
  if (!process.argv.includes('--apply')) return;
  const output = path.resolve('tmp/pedidos-creator');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, `user-genders-backup-${Date.now()}.json`), JSON.stringify(selected.map(({ ref, updateTime, ...row }) => row), null, 2));
  const batch = db.batch();
  for (const row of selected) {
    if (row.before !== row.gender) batch.update(row.ref, { gender: row.gender }, { lastUpdateTime: row.updateTime });
  }
  await batch.commit();
  for (const row of selected) {
    const saved = await row.ref.get();
    if (saved.get('gender') !== row.gender) throw Error(`No se pudo verificar ${row.name}.`);
  }
  console.log('Género guardado y verificado en los tres perfiles.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
