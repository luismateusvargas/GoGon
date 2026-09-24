// scripts/control-plane/hash-password.mjs - CTRL-TASK-001 / AC-CTRL-001
// Prints a GG_ADMIN_PASSWORD_HASH line (scrypt). The password is read from stdin, never argv,
// so it does not land in shell history or process listings.
//   node scripts/control-plane/hash-password.mjs            (type the password, then Enter)
//   <password-file node scripts/control-plane/hash-password.mjs
import readline from 'node:readline';
import { hashPassword } from '../../control-plane/crypto.mjs';

async function readPassword() {
    if (!process.stdin.isTTY) {
        let data = '';
        for await (const chunk of process.stdin) data += chunk;
        return data.replace(/\r?\n$/, '');
    }
    process.stderr.write('Dashboard password (input hidden): ');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = () => {};       // hide typed characters
    const answer = await new Promise(resolve => rl.question('', resolve));
    rl.close();
    process.stderr.write('\n');
    return answer;
}

try {
    const hash = hashPassword(await readPassword());
    console.log(`GG_ADMIN_PASSWORD_HASH=${hash}`);
} catch (e) {
    console.error(e.message);
    process.exitCode = 1;
}
