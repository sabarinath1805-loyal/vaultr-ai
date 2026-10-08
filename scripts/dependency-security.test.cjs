'use strict';

const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const from = tree => createRequire(path.join(root, tree, 'package.json'));

// These are behavioral checks, not substitutes for npm audit. In particular,
// the normal glob/DOCX checks do not claim to patch unresolved advisories.
test('patched proxy trust rejects unrelated IPv4 addresses for mapped subnets', () => {
    for (const tree of ['backend', 'frontend', 'word-addin']) {
        const proxy = from(tree)('proxy-addr');
        assert.equal(proxy.compile(['::ffff:10.0.0.0/8'])('203.0.113.10'), false);
        assert.equal(proxy.compile(['10.0.0.0/8'])('10.1.2.3'), true);
    }
});

test('shell-quote rejects line terminators after comments without executing a shell', () => {
    const { quote, parse } = from('word-addin')('shell-quote');
    for (const separator of ['\n', '\r', '\u2028', '\u2029']) {
        assert.throws(() => quote([{ comment: 'test' }, `plain${separator}text`]), TypeError);
    }
    const tokens = ['plain', 'file with spaces.docx', "apostrophe's", 'literal$variable'];
    assert.deepEqual(parse(quote(tokens), {}), tokens);
});

test('patched CSS selector parser preserves namespaces, escapes, and flat selector lists', () => {
    const parser = from('word-addin')('postcss-selector-parser');
    for (const selector of ['svg|a[href]', '.file\\:name > a:hover', 'a, b, c', '[data-name="a,b"]']) {
        assert.equal(parser().processSync(selector), selector);
    }
    const input = Array.from({ length: 200 }, (_, i) => `.item-${i}`).join(',');
    assert.equal(parser().astSync(input).nodes.length, 200);
});

test('glob tooling retains nested alternatives, ranges, escaped literals and matching', () => {
    for (const tree of ['frontend', 'word-addin']) {
        const requireTree = from(tree);
        const braces = requireTree('braces');
        const match = requireTree('micromatch');
        assert.deepEqual(braces.expand('src/{a,{b,c}}.{ts,tsx}'), [
            'src/a.ts', 'src/a.tsx', 'src/b.ts', 'src/b.tsx', 'src/c.ts', 'src/c.tsx',
        ]);
        assert.deepEqual(braces.expand('file{01..03}.txt'), ['file01.txt', 'file02.txt', 'file03.txt']);
        assert.deepEqual(braces.expand('literal\\{a,b\\}'), ['literal{a,b}']);
        assert.deepEqual(match(['src/a.ts', 'src/b.tsx', 'src/c.js'], ['src/*.{ts,tsx}']), ['src/a.ts', 'src/b.tsx']);
    }
});

test('both Mammoth libraries preserve synthetic DOCX text extraction', async () => {
    const { Document, Paragraph, Packer } = from('backend')('docx');
    const buffer = await Packer.toBuffer(new Document({
        sections: [{ children: [new Paragraph('Synthetic Vaultr legal document'), new Paragraph('Clause 1: test only.')] }],
    }));
    for (const tree of ['backend', 'frontend']) {
        const result = await from(tree)('mammoth').extractRawText({ buffer });
        assert.equal(result.value, 'Synthetic Vaultr legal document\n\nClause 1: test only.\n\n');
    }
});

test('Word tooling can load patched SDK through its existing CommonJS transport APIs', async () => {
    const requireTree = from('word-addin');
    const { Client } = requireTree('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = requireTree('@modelcontextprotocol/sdk/client/streamableHttp.js');
    assert.equal(typeof Client, 'function');
    assert.equal(typeof StreamableHTTPClientTransport, 'function');
});

test('compression releases its gzip stream when a local response is aborted', { timeout: 5000 }, async t => {
    const http = require('node:http');
    const zlib = require('node:zlib');
    const original = Object.getOwnPropertyDescriptor(zlib, 'createGzip');
    let stream;
    Object.defineProperty(zlib, 'createGzip', {
        ...original,
        value: (...args) => {
            stream = original.value(...args);
            return stream;
        },
    });
    t.after(() => Object.defineProperty(zlib, 'createGzip', original));
    const compress = from('word-addin')('compression')({ threshold: 0 });
    const server = http.createServer((req, res) => {
        compress(req, res, () => {
            res.setHeader('Content-Type', 'text/plain');
            res.write('Synthetic compression test. '.repeat(100));
            res.flush();
            // Intentionally leave this one response open until the client
            // aborts. This is bounded local traffic, not a stress payload.
        });
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve, reject) => {
        const request = http.get({
            hostname: '127.0.0.1', port: server.address().port,
            headers: { 'Accept-Encoding': 'gzip' },
        }, response => {
            response.once('data', () => {
                request.destroy();
                setTimeout(resolve, 20);
            });
        });
        request.on('error', reject);
    });
    assert.ok(stream, 'gzip stream was created');
    assert.equal(stream.destroyed, true);
});

test('argparse override preserves Mammoth CLI parsing and DOCX conversion', async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const { spawnSync } = require('node:child_process');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultr-docx-security-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { Document, Paragraph, Packer } = from('backend')('docx');
    const input = path.join(directory, 'synthetic document.docx');
    fs.writeFileSync(input, await Packer.toBuffer(new Document({
        sections: [{ children: [new Paragraph('Synthetic Vaultr legal document')] }],
    })));
    for (const tree of ['backend', 'frontend']) {
        const cli = path.join(path.dirname(from(tree).resolve('mammoth/package.json')), 'bin/mammoth');
        const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
        const help = run(['--help']);
        assert.equal(help.status, 0, help.stderr);
        assert.match(help.stdout, /--output-format/);
        const converted = run([input, '--output-format', 'html']);
        assert.equal(converted.status, 0, converted.stderr);
        assert.match(converted.stdout, /<p>Synthetic Vaultr legal document<\/p>/);
        const invalid = run([input, '--not-a-valid-option']);
        assert.equal(invalid.status, 2);
        const conflict = run([input, path.join(directory, 'output.html'), '--output-dir', directory]);
        assert.equal(conflict.status, 2);
    }
});
