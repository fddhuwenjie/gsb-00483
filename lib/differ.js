const parser = require('./parser');

function compareOpenAPI(file1, file2) {
  const api1 = parser.parseOpenAPI(file1);
  const api2 = parser.parseOpenAPI(file2);

  const result = {
    version1: api1.info.version,
    version2: api2.info.version,
    title1: api1.info.title,
    title2: api2.info.title,
    added: [],
    removed: [],
    modified: [],
    breakingChanges: 0,
    totalChanges: 0
  };

  const endpoints1 = buildEndpointMap(api1.endpoints);
  const endpoints2 = buildEndpointMap(api2.endpoints);

  for (const key in endpoints2) {
    if (!endpoints1[key]) {
      result.added.push({
        method: endpoints2[key].method,
        path: endpoints2[key].path,
        summary: endpoints2[key].summary,
        operationId: endpoints2[key].operationId
      });
    } else {
      const changes = compareEndpoint(endpoints1[key], endpoints2[key]);
      if (changes.length > 0) {
        result.modified.push({
          method: endpoints2[key].method,
          path: endpoints2[key].path,
          summary: endpoints2[key].summary,
          operationId: endpoints2[key].operationId,
          changes
        });
        const breakingCount = changes.filter(c => c.breaking).length;
        result.breakingChanges += breakingCount;
      }
    }
  }

  for (const key in endpoints1) {
    if (!endpoints2[key]) {
      result.removed.push({
        method: endpoints1[key].method,
        path: endpoints1[key].path,
        summary: endpoints1[key].summary,
        operationId: endpoints1[key].operationId
      });
      result.breakingChanges++;
    }
  }

  result.totalChanges = result.added.length + result.removed.length + result.modified.length;

  return result;
}

function buildEndpointMap(endpoints) {
  const map = {};
  for (const ep of endpoints) {
    const key = `${ep.method.toUpperCase()} ${ep.path}`;
    map[key] = ep;
  }
  return map;
}

function compareEndpoint(ep1, ep2) {
  const changes = [];

  const paramChanges = compareParameters(ep1.parameters, ep2.parameters);
  changes.push(...paramChanges);

  const responseChanges = compareResponses(ep1.responses, ep2.responses);
  changes.push(...responseChanges);

  const bodyChanges = compareRequestBody(ep1.requestBody, ep2.requestBody);
  changes.push(...bodyChanges);

  return changes;
}

function compareParameters(params1, params2) {
  const changes = [];

  for (const type of ['path', 'query', 'header', 'cookie']) {
    const p1 = buildParamMap(params1[type] || []);
    const p2 = buildParamMap(params2[type] || []);

    for (const name in p2) {
      if (!p1[name]) {
        changes.push({
          type: 'parameter_added',
          location: type,
          name,
          description: `Added ${type} parameter: ${name}`,
          breaking: p2[name].required === true
        });
      } else {
        const paramChanges = compareParameter(p1[name], p2[name], type);
        changes.push(...paramChanges);
      }
    }

    for (const name in p1) {
      if (!p2[name]) {
        changes.push({
          type: 'parameter_removed',
          location: type,
          name,
          description: `Removed ${type} parameter: ${name}`,
          breaking: true
        });
      }
    }
  }

  return changes;
}

function buildParamMap(params) {
  const map = {};
  for (const p of params) {
    map[p.name] = p;
  }
  return map;
}

function compareParameter(p1, p2, location) {
  const changes = [];

  if (p1.required !== p2.required) {
    if (p2.required === true) {
      changes.push({
        type: 'parameter_required_added',
        location,
        name: p2.name,
        description: `Parameter ${p2.name} changed from optional to required`,
        breaking: true
      });
    } else {
      changes.push({
        type: 'parameter_required_removed',
        location,
        name: p2.name,
        description: `Parameter ${p2.name} changed from required to optional`,
        breaking: false
      });
    }
  }

  const schemaChanges = compareSchema(p1.schema, p2.schema, `parameter ${p2.name}`);
  changes.push(...schemaChanges);

  return changes;
}

function compareResponses(res1, res2) {
  const changes = [];

  const codes1 = Object.keys(res1 || {});
  const codes2 = Object.keys(res2 || {});

  for (const code of codes2) {
    if (!codes1.includes(code)) {
      changes.push({
        type: 'response_added',
        statusCode: code,
        description: `Added response status code: ${code}`,
        breaking: false
      });
    } else {
      const schema1 = parser.getResponseSchema(res1[code]);
      const schema2 = parser.getResponseSchema(res2[code]);
      const schemaChanges = compareSchema(schema1, schema2, `response ${code}`);
      changes.push(...schemaChanges);
    }
  }

  for (const code of codes1) {
    if (!codes2.includes(code)) {
      changes.push({
        type: 'response_removed',
        statusCode: code,
        description: `Removed response status code: ${code}`,
        breaking: code.startsWith('2')
      });
    }
  }

  return changes;
}

function compareRequestBody(body1, body2) {
  const changes = [];

  if (!body1 && !body2) return changes;

  if (body1 && !body2) {
    changes.push({
      type: 'request_body_removed',
      description: 'Removed request body',
      breaking: true
    });
    return changes;
  }

  if (!body1 && body2) {
    changes.push({
      type: 'request_body_added',
      description: 'Added request body',
      breaking: body2.required === true
    });
    return changes;
  }

  if (body1.required !== body2.required) {
    if (body2.required === true) {
      changes.push({
        type: 'request_body_required_added',
        description: 'Request body changed from optional to required',
        breaking: true
      });
    } else {
      changes.push({
        type: 'request_body_required_removed',
        description: 'Request body changed from required to optional',
        breaking: false
      });
    }
  }

  const schema1 = parser.getRequestBodySchema(body1);
  const schema2 = parser.getRequestBodySchema(body2);
  const schemaChanges = compareSchema(schema1, schema2, 'request body');
  changes.push(...schemaChanges);

  return changes;
}

function compareSchema(schema1, schema2, context = '') {
  const changes = [];

  if (!schema1 && !schema2) return changes;

  if (schema1 && !schema2) {
    changes.push({
      type: 'schema_removed',
      context,
      description: `${context}: Schema removed`,
      breaking: true
    });
    return changes;
  }

  if (!schema1 && schema2) {
    changes.push({
      type: 'schema_added',
      context,
      description: `${context}: Schema added`,
      breaking: false
    });
    return changes;
  }

  if (schema1.type !== schema2.type) {
    changes.push({
      type: 'type_changed',
      context,
      description: `${context}: Type changed from ${schema1.type} to ${schema2.type}`,
      oldType: schema1.type,
      newType: schema2.type,
      breaking: true
    });
  }

  if (schema1.type === 'object' && schema2.type === 'object') {
    const props1 = schema1.properties || {};
    const props2 = schema2.properties || {};
    const required1 = schema1.required || [];
    const required2 = schema2.required || [];

    for (const propName in props2) {
      if (!props1[propName]) {
        const isRequired = required2.includes(propName);
        changes.push({
          type: 'property_added',
          context,
          property: propName,
          description: `${context}: Added property ${propName}`,
          breaking: isRequired
        });
      } else {
        const propChanges = compareSchema(props1[propName], props2[propName], `${context}.${propName}`);
        changes.push(...propChanges);
      }
    }

    for (const propName in props1) {
      if (!props2[propName]) {
        changes.push({
          type: 'property_removed',
          context,
          property: propName,
          description: `${context}: Removed property ${propName}`,
          breaking: true
        });
      }
    }

    for (const reqField of required2) {
      if (!required1.includes(reqField) && props1[reqField]) {
        changes.push({
          type: 'required_field_added',
          context,
          property: reqField,
          description: `${context}: Property ${reqField} changed from optional to required`,
          breaking: true
        });
      }
    }

    for (const reqField of required1) {
      if (!required2.includes(reqField)) {
        changes.push({
          type: 'required_field_removed',
          context,
          property: reqField,
          description: `${context}: Property ${reqField} changed from required to optional`,
          breaking: false
        });
      }
    }
  }

  if (schema1.type === 'array' && schema2.type === 'array') {
    const itemChanges = compareSchema(schema1.items, schema2.items, `${context}[]`);
    changes.push(...itemChanges);
  }

  return changes;
}

function formatConsole(diffResult) {
  const lines = [];
  const width = 80;
  const separator = '═'.repeat(width);

  lines.push('');
  lines.push(separator);
  lines.push(centerText(' OPENAPI SPEC DIFF ', width, '═'));
  lines.push(separator);
  lines.push('');
  lines.push(`  Version: ${diffResult.version1} → ${diffResult.version2}`);
  lines.push(`  API: ${diffResult.title1}`);
  lines.push('');
  lines.push(`  Total Changes: ${diffResult.totalChanges}`);
  lines.push(`  ➕ Added: ${diffResult.added.length}`);
  lines.push(`  ➖ Removed: ${diffResult.removed.length}`);
  lines.push(`  ✏️  Modified: ${diffResult.modified.length}`);
  lines.push(`  ⚠️  Breaking Changes: ${diffResult.breakingChanges}`);
  lines.push('');

  if (diffResult.added.length > 0) {
    lines.push('━━━  Added Endpoints  ━━━');
    lines.push('');
    for (const ep of diffResult.added) {
      lines.push(`  ➕ ${ep.method.padEnd(7)} ${ep.path}`);
      if (ep.summary) {
        lines.push(`     ${ep.summary}`);
      }
    }
    lines.push('');
  }

  if (diffResult.removed.length > 0) {
    lines.push('━━━  Removed Endpoints  ━━━');
    lines.push('');
    for (const ep of diffResult.removed) {
      lines.push(`  ➖ ${ep.method.padEnd(7)} ${ep.path}`);
      if (ep.summary) {
        lines.push(`     ${ep.summary}`);
      }
    }
    lines.push('');
  }

  if (diffResult.modified.length > 0) {
    lines.push('━━━  Modified Endpoints  ━━━');
    lines.push('');
    for (const ep of diffResult.modified) {
      const hasBreaking = ep.changes.some(c => c.breaking);
      const breakingIcon = hasBreaking ? '⚠️ ' : '✏️ ';
      lines.push(`  ${breakingIcon} ${ep.method.padEnd(7)} ${ep.path}`);
      if (ep.summary) {
        lines.push(`     ${ep.summary}`);
      }
      for (const change of ep.changes) {
        const icon = change.breaking ? '🔴' : '🟡';
        lines.push(`     ${icon} ${change.description}`);
      }
      lines.push('');
    }
  }

  lines.push(separator);
  lines.push('');

  return lines.join('\n');
}

function formatMarkdown(diffResult) {
  const lines = [];

  lines.push('# OpenAPI Specification Diff');
  lines.push('');
  lines.push(`**API:** ${diffResult.title1}`);
  lines.push(`**Version:** ${diffResult.version1} → ${diffResult.version2}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|--------|-------|');
  lines.push(`| Total Changes | ${diffResult.totalChanges} |`);
  lines.push(`| ➕ Added Endpoints | ${diffResult.added.length} |`);
  lines.push(`| ➖ Removed Endpoints | ${diffResult.removed.length} |`);
  lines.push(`| ✏️  Modified Endpoints | ${diffResult.modified.length} |`);
  lines.push(`| ⚠️  **Breaking Changes** | **${diffResult.breakingChanges}** |`);
  lines.push('');

  if (diffResult.added.length > 0) {
    lines.push('## Added Endpoints');
    lines.push('');
    for (const ep of diffResult.added) {
      lines.push(`- \`${ep.method}\` **${ep.path}**`);
      if (ep.summary) {
        lines.push(`  - ${ep.summary}`);
      }
      if (ep.operationId) {
        lines.push(`  - Operation: \`${ep.operationId}\``);
      }
    }
    lines.push('');
  }

  if (diffResult.removed.length > 0) {
    lines.push('## Removed Endpoints');
    lines.push('');
    lines.push('> ⚠️ **Breaking Change:** Removing endpoints is a breaking change');
    lines.push('');
    for (const ep of diffResult.removed) {
      lines.push(`- ~~\`${ep.method}\` **${ep.path}**~~`);
      if (ep.summary) {
        lines.push(`  - ${ep.summary}`);
      }
      if (ep.operationId) {
        lines.push(`  - Operation: \`${ep.operationId}\``);
      }
    }
    lines.push('');
  }

  if (diffResult.modified.length > 0) {
    lines.push('## Modified Endpoints');
    lines.push('');
    for (const ep of diffResult.modified) {
      const hasBreaking = ep.changes.some(c => c.breaking);
      const badge = hasBreaking ? '⚠️ Breaking' : '✏️ Non-breaking';
      const badgeClass = hasBreaking ? '**' : '';
      lines.push(`### ${badgeClass}${badge}${badgeClass}: \`${ep.method}\` ${ep.path}`);
      lines.push('');
      if (ep.summary) {
        lines.push(`*${ep.summary}*`);
        lines.push('');
      }
      lines.push('**Changes:**');
      lines.push('');
      for (const change of ep.changes) {
        const icon = change.breaking ? '🔴' : '🟡';
        lines.push(`- ${icon} ${change.description}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function formatJson(diffResult) {
  return JSON.stringify(diffResult, null, 2);
}

function formatDiff(diffResult, format = 'console') {
  switch (format) {
    case 'json':
      return formatJson(diffResult);
    case 'markdown':
      return formatMarkdown(diffResult);
    case 'console':
    default:
      return formatConsole(diffResult);
  }
}

function centerText(text, width, char = ' ') {
  const padLeft = Math.floor((width - text.length) / 2);
  const padRight = width - text.length - padLeft;
  return char.repeat(padLeft) + text + char.repeat(padRight);
}

module.exports = {
  compareOpenAPI,
  formatDiff,
  formatConsole,
  formatMarkdown,
  formatJson
};
