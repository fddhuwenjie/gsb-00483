function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(randomInt(0, chars.length - 1));
  }
  return result;
}

function randomEmail() {
  const domains = ['example.com', 'test.org', 'mail.net', 'gmail.com', 'yahoo.com'];
  return `${randomString(8)}@${domains[randomInt(0, domains.length - 1)]}`;
}

function randomUrl() {
  const protocols = ['http', 'https'];
  const domains = ['example.com', 'test.org', 'api.io', 'service.net'];
  return `${protocols[randomInt(0, protocols.length - 1)]}://${domains[randomInt(0, domains.length - 1)]}/${randomString(10)}`;
}

function randomDate() {
  const start = new Date(2020, 0, 1);
  const end = new Date(2025, 11, 31);
  const date = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
  return date.toISOString().split('T')[0];
}

function randomDateTime() {
  const start = new Date(2020, 0, 1);
  const end = new Date(2025, 11, 31);
  const date = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
  return date.toISOString();
}

function randomUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function randomBoolean() {
  return Math.random() > 0.5;
}

function generateString(schema) {
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[randomInt(0, schema.enum.length - 1)];
  }
  
  if (schema.pattern) {
    return generateStringFromPattern(schema.pattern);
  }
  
  const minLength = schema.minLength || 1;
  const maxLength = schema.maxLength || 50;
  const length = randomInt(minLength, maxLength);
  
  if (schema.format) {
    switch (schema.format) {
      case 'email':
        return randomEmail();
      case 'url':
        return randomUrl();
      case 'date':
        return randomDate();
      case 'date-time':
        return randomDateTime();
      case 'uuid':
        return randomUUID();
      case 'password':
        return randomString(Math.max(length, 8));
      case 'hostname':
        return `${randomString(5)}.${randomString(3)}`;
      case 'ipv4':
        return `${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(0, 255)}`;
      default:
        return randomString(length);
    }
  }
  
  return randomString(length);
}

function generateStringFromPattern(pattern) {
  let result;
  let attempts = 0;
  const maxAttempts = 50;

  try {
    const regex = new RegExp(pattern);
    const generator = new RegexPatternGenerator();

    while (attempts < maxAttempts) {
      try {
        result = generator.generate(pattern);
        if (regex.test(result)) {
          return result;
        }
      } catch (e) {}
      attempts++;
    }

    result = generateStringByHeuristics(pattern);
    attempts = 0;
    while (!regex.test(result) && attempts < maxAttempts) {
      result = generateStringByHeuristics(pattern);
      attempts++;
    }

    if (regex.test(result)) {
      return result;
    }

    return generateGuaranteedMatch(pattern, regex);
  } catch (e) {
    return generateStringByHeuristics(pattern);
  }
}

class RegexPatternGenerator {
  constructor() {
    this.pos = 0;
    this.pattern = '';
  }

  generate(pattern) {
    this.pattern = pattern;
    this.pos = 0;
    let result = this.parseAlternation();
    if (this.pos < this.pattern.length && this.peek() === '$') {
      this.next();
    }
    return result;
  }

  peek() {
    return this.pattern[this.pos];
  }

  next() {
    return this.pattern[this.pos++];
  }

  eof() {
    return this.pos >= this.pattern.length;
  }

  parseAlternation() {
    const alternatives = [];
    alternatives.push(this.parseSequence());
    while (!this.eof() && this.peek() === '|') {
      this.next();
      alternatives.push(this.parseSequence());
    }
    return alternatives[randomInt(0, alternatives.length - 1)];
  }

  parseSequence() {
    let result = '';
    while (!this.eof() && this.peek() !== '|' && this.peek() !== ')' && this.peek() !== '$') {
      result += this.parseQuantified();
    }
    return result;
  }

  parseQuantified() {
    let atom = this.parseAtom();
    if (this.eof()) return atom;

    const ch = this.peek();
    if (ch === '*') {
      this.next();
      const n = randomInt(0, 5);
      let s = '';
      for (let i = 0; i < n; i++) s += atom;
      return s;
    } else if (ch === '+') {
      this.next();
      const n = randomInt(1, 5);
      let s = '';
      for (let i = 0; i < n; i++) s += atom;
      return s;
    } else if (ch === '?') {
      this.next();
      return Math.random() < 0.7 ? atom : '';
    } else if (ch === '{') {
      return this.parseQuantifierBraces(atom);
    }
    return atom;
  }

  parseQuantifierBraces(atom) {
    this.next();
    let minStr = '';
    while (!this.eof() && /\d/.test(this.peek())) {
      minStr += this.next();
    }
    let min = parseInt(minStr) || 0;
    let max = min;

    if (!this.eof() && this.peek() === ',') {
      this.next();
      let maxStr = '';
      while (!this.eof() && /\d/.test(this.peek())) {
        maxStr += this.next();
      }
      max = maxStr ? parseInt(maxStr) : Math.max(min, min + 5);
    }

    if (!this.eof() && this.peek() === '}') {
      this.next();
    }

    max = Math.min(max, Math.max(min, min + 10));
    const n = randomInt(min, max);
    let s = '';
    for (let i = 0; i < n; i++) s += atom;
    return s;
  }

  parseAtom() {
    if (this.eof()) return '';
    const ch = this.peek();

    if (ch === '^') {
      this.next();
      return '';
    }

    if (ch === '$') {
      return '';
    }

    if (ch === '.') {
      this.next();
      return this.randomCharFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
    }

    if (ch === '(') {
      return this.parseGroup();
    }

    if (ch === '[') {
      return this.parseCharacterClass();
    }

    if (ch === '\\') {
      this.next();
      return this.parseEscape();
    }

    this.next();
    return ch;
  }

  parseGroup() {
    this.next();
    
    if (this.peek() === '?') {
      this.next();
      const special = this.next();
      if (special === ':' || special === '=' || special === '!') {
        let result = this.parseAlternation();
        if (!this.eof() && this.peek() === ')') {
          this.next();
        }
        if (special === '!' || special === '=') {
          return '';
        }
        return result;
      }
    }

    let result = this.parseAlternation();
    if (!this.eof() && this.peek() === ')') {
      this.next();
    }
    return result;
  }

  parseCharacterClass() {
    this.next();
    let negated = false;
    if (!this.eof() && this.peek() === '^') {
      negated = true;
      this.next();
    }

    let chars = '';
    let firstChar = true;
    while (!this.eof() && (this.peek() !== ']' || firstChar)) {
      firstChar = false;
      const start = this.next();
      
      if (start === '\\' && !this.eof()) {
        chars += this.parseEscapeCharClass();
      } else if (!this.eof() && this.peek() === '-' && this.pattern[this.pos + 1] !== ']' && this.pattern[this.pos + 1] !== undefined) {
        this.next();
        const end = this.next();
        const startCode = start.charCodeAt(0);
        const endCode = end.charCodeAt(0);
        const minCode = Math.min(startCode, endCode);
        const maxCode = Math.max(startCode, endCode);
        for (let c = minCode; c <= maxCode; c++) {
          chars += String.fromCharCode(c);
        }
      } else {
        chars += start;
      }
    }
    if (!this.eof() && this.peek() === ']') {
      this.next();
    }

    if (negated) {
      let allChars = '';
      for (let c = 32; c <= 126; c++) {
        if (!chars.includes(String.fromCharCode(c))) {
          allChars += String.fromCharCode(c);
        }
      }
      chars = allChars || chars;
    }

    if (chars.length === 0) chars = 'abc';
    return this.randomCharFrom(chars);
  }

  parseEscapeCharClass() {
    if (this.eof()) return '';
    const ch = this.next();
    switch (ch) {
      case 'd': return '0123456789';
      case 'D': return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
      case 'w': return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';
      case 'W': return '!@#$%^&*()-+=[]{};:,.<>?/';
      case 's': return ' \t';
      case 'S': return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      default: return ch;
    }
  }

  parseEscape() {
    if (this.eof()) return '';
    const ch = this.next();
    switch (ch) {
      case 'd':
        return this.randomCharFrom('0123456789');
      case 'D':
        return this.randomCharFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
      case 'w':
        return this.randomCharFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_');
      case 'W':
        return this.randomCharFrom('!@#$%^&*()-+=[]{};:,.<>?/');
      case 's':
        return this.randomCharFrom(' \t');
      case 'S':
        return this.randomCharFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
      case 'b':
      case 'B':
        return '';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case '0':
        return '\0';
      default:
        return ch;
    }
  }

  randomCharFrom(chars) {
    return chars.charAt(randomInt(0, chars.length - 1));
  }
}

function generateGuaranteedMatch(pattern, regex) {
  const strategies = [
    () => {
      const match = pattern.match(/^\^?(.*?)\$?$/);
      const core = match ? match[1] : pattern;
      if (/^[a-zA-Z0-9]+$/.test(core)) {
        return core;
      }
      return null;
    },
    () => {
      if (/^\^?\[a-z\]\*?\$?$/i.test(pattern)) {
        return randomString(10).toLowerCase();
      }
      if (/^\^?\[a-zA-Z\]\*?\$?$/.test(pattern)) {
        return randomString(10);
      }
      if (/^\^?\[0-9\]\*?\$?$/.test(pattern) || /^\^?\\d\+?\$?$/.test(pattern)) {
        let s = '';
        for (let i = 0; i < 10; i++) s += randomInt(0, 9);
        return s;
      }
      if (/^\^?\\w\+?\$?$/.test(pattern)) {
        return randomString(10) + '_';
      }
      return null;
    },
    () => {
      const charClassMatch = pattern.match(/\[([^\]]+)\]/);
      if (charClassMatch) {
        const chars = expandCharClass(charClassMatch[1]);
        if (chars) {
          let s = '';
          const len = randomInt(5, 15);
          for (let i = 0; i < len; i++) {
            s += chars.charAt(randomInt(0, chars.length - 1));
          }
          if (regex.test(s)) return s;
        }
      }
      return null;
    },
    () => {
      for (let len = 1; len <= 50; len++) {
        for (let attempt = 0; attempt < 200; attempt++) {
          let s = '';
          for (let i = 0; i < len; i++) {
            s += String.fromCharCode(randomInt(32, 126));
          }
          if (regex.test(s)) return s;
        }
      }
      return null;
    },
    () => {
      const samples = ['test', 'abc123', 'hello_world', 'Test123', 'user-name', 'test@example.com', 'http://example.com'];
      for (const s of samples) {
        if (regex.test(s)) return s;
      }
      for (let i = 0; i < 1000; i++) {
        const s = randomString(randomInt(1, 30));
        if (regex.test(s)) return s;
      }
      return randomString(10);
    }
  ];

  for (const strategy of strategies) {
    try {
      const result = strategy();
      if (result !== null && regex.test(result)) {
        return result;
      }
    } catch (e) {}
  }

  return randomString(10);
}

function expandCharClass(charClass) {
  let chars = '';
  let i = 0;
  let negated = false;

  if (charClass[0] === '^') {
    negated = true;
    i = 1;
  }

  while (i < charClass.length) {
    const c = charClass[i];
    if (c === '-' && i > 0 && i < charClass.length - 1) {
      const start = charClass.charCodeAt(i - 1);
      const end = charClass.charCodeAt(i + 1);
      for (let code = start + 1; code <= end; code++) {
        chars += String.fromCharCode(code);
      }
      i += 2;
    } else if (c === '\\' && i < charClass.length - 1) {
      const next = charClass[i + 1];
      switch (next) {
        case 'd': chars += '0123456789'; break;
        case 'D': chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; break;
        case 'w': chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'; break;
        case 'W': chars += '!@#$%^&*()-+=[]{};:,.<>?/'; break;
        case 's': chars += ' \t'; break;
        case 'S': chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; break;
        default: chars += next;
      }
      i += 2;
    } else {
      chars += c;
      i++;
    }
  }

  if (negated) {
    let allChars = '';
    for (let c = 32; c <= 126; c++) {
      if (!chars.includes(String.fromCharCode(c))) {
        allChars += String.fromCharCode(c);
      }
    }
    chars = allChars || chars;
  }

  return chars;
}

function generateStringByHeuristics(pattern) {
  const samples = [
    { test: /username|user.*name/i, gen: () => `user_${randomString(6).toLowerCase()}` },
    { test: /email/i, gen: () => randomEmail() },
    { test: /phone|tel|mobile/i, gen: () => `+1-${randomInt(100, 999)}-${randomInt(100, 999)}-${randomInt(1000, 9999)}` },
    { test: /url|uri|href|link/i, gen: () => randomUrl() },
    { test: /date|time/i, gen: () => randomDateTime() },
    { test: /uuid|guid/i, gen: () => randomUUID() },
    { test: /id|identifier/i, gen: () => randomInt(1, 9999).toString() },
    { test: /password|passwd|pwd/i, gen: () => `${randomString(6)}1${randomString(2).toUpperCase()}` },
    { test: /name/i, gen: () => `${randomString(5).charAt(0).toUpperCase()}${randomString(5).slice(1)}` },
    { test: /status|state/i, gen: () => ['active', 'pending', 'inactive'][randomInt(0, 2)] },
    { test: /type|kind/i, gen: () => ['standard', 'premium', 'basic'][randomInt(0, 2)] }
  ];

  for (const s of samples) {
    if (s.test.test(pattern)) {
      return s.gen();
    }
  }

  if (/\[a-z[A-Z]/.test(pattern) || /\w/.test(pattern)) {
    return randomString(randomInt(5, 15));
  }
  if (/\d/.test(pattern) || /\[0-9\]/.test(pattern)) {
    let result = '';
    for (let i = 0; i < randomInt(5, 10); i++) {
      result += randomInt(0, 9).toString();
    }
    return result;
  }

  let generated = randomString(randomInt(5, 20));
  try {
    const regex = new RegExp(pattern);
    let attempts = 0;
    while (!regex.test(generated) && attempts < 100) {
      generated = randomString(randomInt(3, 30));
      attempts++;
    }
  } catch (e) {}
  return generated;
}

function generateNumber(schema) {
  const minimum = schema.minimum !== undefined ? schema.minimum : 0;
  const maximum = schema.maximum !== undefined ? schema.maximum : 1000;
  const exclusiveMin = schema.exclusiveMinimum ? 1 : 0;
  const exclusiveMax = schema.exclusiveMaximum ? 1 : 0;
  
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[randomInt(0, schema.enum.length - 1)];
  }
  
  if (schema.format === 'int64' || schema.format === 'int32' || schema.type === 'integer') {
    return randomInt(minimum + exclusiveMin, maximum - exclusiveMax);
  }
  
  if (schema.format === 'float' || schema.format === 'double') {
    return parseFloat(randomFloat(minimum + exclusiveMin, maximum - exclusiveMax).toFixed(2));
  }
  
  return randomInt(minimum + exclusiveMin, maximum - exclusiveMax);
}

function generateArray(schema, ignoreExample = false) {
  const minItems = schema.minItems || 0;
  const maxItems = schema.maxItems || 10;
  const length = randomInt(minItems, maxItems);
  
  const result = [];
  for (let i = 0; i < length; i++) {
    result.push(generateFromSchema(schema.items || {}, false, ignoreExample));
  }
  return result;
}

function generateObject(schema, ensureAllRequired = false, ignoreExample = false) {
  const result = {};
  const properties = schema.properties || {};
  const required = schema.required || [];
  
  for (const propName in properties) {
    const propSchema = properties[propName];
    const isNestedObject = propSchema.type === 'object' || propSchema.$ref;
    const isRequired = required.includes(propName);
    
    if (ensureAllRequired || isRequired || isNestedObject || Math.random() > 0.3) {
      result[propName] = generateFromSchema(propSchema, ensureAllRequired, ignoreExample);
    }
  }
  
  for (const reqProp of required) {
    if (result[reqProp] === undefined) {
      result[reqProp] = generateFromSchema(properties[reqProp] || {}, ensureAllRequired, ignoreExample);
    }
  }
  
  return result;
}

function generateFromSchema(schema, ensureRequired = false, ignoreExample = false) {
  if (!schema) return null;
  
  if (!ignoreExample && schema.example !== undefined) {
    return schema.example;
  }
  
  if (schema.default !== undefined) {
    return schema.default;
  }
  
  const type = schema.type || 'object';
  
  switch (type) {
    case 'string':
      return generateString(schema);
    case 'integer':
    case 'number':
      return generateNumber(schema);
    case 'boolean':
      return randomBoolean();
    case 'array':
      return generateArray(schema, ignoreExample);
    case 'object':
      return generateObject(schema, ensureRequired, ignoreExample);
    case 'null':
      return null;
    default:
      return generateObject(schema, ensureRequired, ignoreExample);
  }
}

function generateInvalidString(schema) {
  if (schema.enum && schema.enum.length > 0) {
    const invalidValues = ['invalid_enum_value', 'wrong', 'not_in_list'];
    return invalidValues[randomInt(0, invalidValues.length - 1)];
  }
  
  if (schema.minLength && schema.minLength > 0) {
    return randomString(schema.minLength - 1);
  }
  
  if (schema.maxLength) {
    return randomString(schema.maxLength + 10);
  }
  
  if (schema.pattern) {
    return '!@#$%^&*()';
  }
  
  if (schema.format === 'email') {
    return 'not-an-email';
  }
  
  if (schema.format === 'url') {
    return 'not-a-url';
  }
  
  if (schema.format === 'date') {
    return 'not-a-date';
  }
  
  return '';
}

function generateInvalidNumber(schema) {
  if (schema.minimum !== undefined) {
    return schema.minimum - 100;
  }
  
  if (schema.maximum !== undefined) {
    return schema.maximum + 100;
  }
  
  if (schema.enum && schema.enum.length > 0) {
    return 999999;
  }
  
  return -999;
}

function generateInvalidArray(schema) {
  if (schema.minItems !== undefined && schema.minItems > 0) {
    return [];
  }
  
  if (schema.maxItems !== undefined) {
    const result = [];
    for (let i = 0; i < schema.maxItems + 10; i++) {
      result.push(generateFromSchema(schema.items || {}));
    }
    return result;
  }
  
  return 'not-an-array';
}

function generateInvalidObject(schema) {
  const required = schema.required || [];
  const result = generateObject(schema);
  
  if (required.length > 0) {
    const propToRemove = required[randomInt(0, required.length - 1)];
    delete result[propToRemove];
  }
  
  return result;
}

function generateInvalidFromSchema(schema) {
  if (!schema) return null;
  
  const type = schema.type || 'object';
  
  switch (type) {
    case 'string':
      return generateInvalidString(schema);
    case 'integer':
    case 'number':
      return generateInvalidNumber(schema);
    case 'array':
      return generateInvalidArray(schema);
    case 'object':
      return generateInvalidObject(schema);
    default:
      return null;
  }
}

function generateParameterValue(parameter) {
  return generateFromSchema(parameter.schema || {});
}

function generateInvalidParameterValue(parameter) {
  return generateInvalidFromSchema(parameter.schema || {});
}

function generatePathParams(pathParameters) {
  const params = {};
  for (const param of pathParameters) {
    params[param.name] = generateParameterValue(param);
  }
  return params;
}

function generateQueryParams(queryParameters, requiredOnly = false) {
  const params = {};
  for (const param of queryParameters) {
    if (!requiredOnly || param.required) {
      params[param.name] = generateParameterValue(param);
    }
  }
  return params;
}

function substitutePathParams(path, params) {
  let result = path;
  for (const key in params) {
    result = result.replace(`{${key}}`, params[key]);
  }
  return result;
}

module.exports = {
  generateFromSchema,
  generateInvalidFromSchema,
  generateParameterValue,
  generateInvalidParameterValue,
  generatePathParams,
  generateQueryParams,
  substitutePathParams,
  generateString,
  generateNumber,
  generateArray,
  generateObject
};
