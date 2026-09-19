// Legacy npm entry delegates to the supported compiled operator. Build first.
process.argv.splice(2, 0, 'doctor');
await import('../dist/operator/main.js');
