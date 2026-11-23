// Shared GBNF building blocks. Strings are length-capped so a looping small model
// can't burn the whole token budget inside one JSON string.

export const GBNF_COMMON = String.raw`
ws ::= [ \t\n]{0,2}
char ::= [^"\\\x7F\x00-\x1F] | "\\" ["\\/bfnrt]
str ::= "\"" char{1,160} "\""
shortstr ::= "\"" char{1,60} "\""
num ::= [0-9]{1,9}
date ::= "\"" [0-9]{4} "-" [0-9]{2} "-" [0-9]{2} "\""
`;

/** `"key": <value>` with optional whitespace. */
export const kv = (key: string, value: string) => `"\\"${key}\\"" ws ":" ws ${value}`;
