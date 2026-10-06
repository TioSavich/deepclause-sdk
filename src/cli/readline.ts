import * as readline from 'readline';

/**
 * Ask a single question on stdin. Used for one-shot `run` input requests and
 * the interactive `set-model` picker. (The REPL has its own shared readline.)
 */
export function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
