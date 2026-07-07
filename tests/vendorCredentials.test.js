import GLib from 'gi://GLib';

import {
    assertEqual,
    makeTempDir,
    removeTree,
    restoreEnvironment,
    test,
} from './harness.js';
import {
    credentialPath,
    expandCredentialPath,
} from '../lib/vendorCredentials.js';
import {
    Vendors,
    getDefaultCredentialPath,
    normalizeCredentialPathSetting,
} from '../lib/vendors.js';

test('credential paths support default, absolute, and home-relative locations', () => {
    const homeDir = makeTempDir();

    try {
        assertEqual(
            credentialPath('.codex/auth.json', homeDir),
            GLib.build_filenamev([homeDir, '.codex', 'auth.json'])
        );
        assertEqual(
            credentialPath(
                '.codex/auth.json',
                homeDir,
                GLib.build_filenamev([homeDir, 'custom', 'auth.json'])
            ),
            GLib.build_filenamev([homeDir, 'custom', 'auth.json'])
        );
        assertEqual(
            expandCredentialPath('~/custom/auth.json', homeDir),
            GLib.build_filenamev([homeDir, 'custom', 'auth.json'])
        );
        assertEqual(
            expandCredentialPath('custom/auth.json', homeDir),
            GLib.build_filenamev([homeDir, 'custom', 'auth.json'])
        );
        assertEqual(
            expandCredentialPath('/tmp/codex-auth.json', homeDir),
            '/tmp/codex-auth.json'
        );
        assertEqual(
            normalizeCredentialPathSetting(
                GLib.build_filenamev([homeDir, 'custom', 'auth.json']),
                homeDir
            ),
            '~/custom/auth.json'
        );
        assertEqual(
            normalizeCredentialPathSetting('~/custom/auth.json', homeDir),
            '~/custom/auth.json'
        );
        assertEqual(
            normalizeCredentialPathSetting('/tmp/codex-auth.json', homeDir),
            '/tmp/codex-auth.json'
        );
        assertEqual(
            normalizeCredentialPathSetting(' custom/auth.json ', homeDir),
            'custom/auth.json'
        );
    } finally {
        removeTree(homeDir);
    }
});

test('vendor default credential paths honor config directory environment variables', () => {
    const homeDir = makeTempDir();
    const previousCodexHome = GLib.getenv('CODEX_HOME');
    const previousClaudeConfigDir = GLib.getenv('CLAUDE_CONFIG_DIR');

    try {
        GLib.setenv('CODEX_HOME', GLib.build_filenamev([homeDir, 'codex-home']), true);
        GLib.setenv('CLAUDE_CONFIG_DIR', '~/claude-config', true);

        assertEqual(
            getDefaultCredentialPath(Vendors.OPENAI, {homeDir}),
            GLib.build_filenamev([homeDir, 'codex-home', 'auth.json'])
        );
        assertEqual(
            getDefaultCredentialPath(Vendors.ANTHROPIC, {homeDir}),
            GLib.build_filenamev([homeDir, 'claude-config', '.credentials.json'])
        );
        assertEqual(
            getDefaultCredentialPath(Vendors.OPENAI, {
                homeDir,
                useEnvironment: false,
            }),
            GLib.build_filenamev([homeDir, '.codex', 'auth.json'])
        );
    } finally {
        restoreEnvironment('CODEX_HOME', previousCodexHome);
        restoreEnvironment('CLAUDE_CONFIG_DIR', previousClaudeConfigDir);
        removeTree(homeDir);
    }
});
