const greek = [
  ['alpha', 'α', 'Α'], ['beta', 'β', 'Β'], ['gamma', 'γ', 'Γ'], ['delta', 'δ', 'Δ'],
  ['epsilon', 'ε', 'Ε'], ['zeta', 'ζ', 'Ζ'], ['eta', 'η', 'Η'], ['theta', 'θ', 'Θ'],
  ['iota', 'ι', 'Ι'], ['kappa', 'κ', 'Κ'], ['lambda', 'λ', 'Λ'], ['mu', 'μ', 'Μ'],
  ['nu', 'ν', 'Ν'], ['xi', 'ξ', 'Ξ'], ['omicron', 'ο', 'Ο'], ['pi', 'π', 'Π'],
  ['rho', 'ρ', 'Ρ'], ['sigma', 'σ', 'Σ'], ['tau', 'τ', 'Τ'], ['upsilon', 'υ', 'Υ'],
  ['phi', 'φ', 'Φ'], ['chi', 'χ', 'Χ'], ['psi', 'ψ', 'Ψ'], ['omega', 'ω', 'Ω']
] as const;

export const symbolShorthands = new Map<string, string>([
  ...greek.flatMap(([name, lower, upper]) => [[name, lower], [name[0].toUpperCase() + name.slice(1), upper]] as [string, string][]),
  ['varsigma', 'ς'], ['varepsilon', 'ϵ'], ['vartheta', 'ϑ'], ['varpi', 'ϖ'], ['varrho', 'ϱ'], ['varphi', 'ϕ'],
  ['aleph', 'ℵ'], ['itg', '∫'], ['sqr', '√']
]);

// Consume the whole command so unknown names never render a recognized prefix.
// A doubled backslash keeps the shorthand literal.
export const symbolPattern = /(?<!\\)\\([A-Za-z][A-Za-z0-9-]*)/g;

export function renderSymbolShorthands(text: string) {
  return text.replace(symbolPattern, (source, name: string) => symbolShorthands.get(name) ?? source);
}
