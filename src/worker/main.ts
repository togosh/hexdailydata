// No live work in the starter. Do not pretend that a placeholder job synced anything.
const command = process.argv[2] ?? 'help';
if (command === 'status') {
  console.log(JSON.stringify({ mode: 'scaffold', syncImplemented: false, nextBuildTask: '01' }));
} else if (command === 'help' || command === '--help') {
  console.log('Worker implementation follows tasks02–05/08. Only scaffold status is available.');
} else {
  console.error(`Worker command ${JSON.stringify(command)} is not implemented. No database or provider was accessed.`);
  process.exitCode = 2;
}
