/** The command line of the dictionary scripts. Pure: no I/O. */

export interface Args {
  /** What is not an option, in order. */
  words: string[];
  /** `--name value` → value. */
  values: Record<string, string>;
  /** The options without a value that were given. */
  flags: Set<string>;
}

/**
 * Splits a command line into its words and its options, which may stand anywhere. `values` names the options that
 * take a value (`--level a1`), `flags` those that do not (`--check`). A bare `--`, which a package manager may put
 * before the options (`pnpm validate -- --base master`), is skipped. Throws on an option that is not named, on one
 * given twice, and on one without its value.
 */
export function parseArgs(args: readonly string[], spec: { values?: readonly string[]; flags?: readonly string[] } = {}): Args {
  const out: Args = { words: [], values: {}, flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") continue;
    if (!arg.startsWith("--")) { out.words.push(arg); continue; }
    const name = arg.slice(2);
    if (name in out.values || out.flags.has(name)) throw new Error(`параметр ${arg} указан дважды`);
    if (spec.flags?.includes(name)) out.flags.add(name);
    else if (spec.values?.includes(name)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`у параметра ${arg} нет значения`);
      out.values[name] = value;
    } else throw new Error(`неизвестный параметр ${arg}`);
  }
  return out;
}
