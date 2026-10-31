const vscode = require('vscode');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');

const AUTH_TYPE = 'mhentuniverse';
const AUTH_NAME = 'MHEnt Universe Account';
const SESSIONS_SECRET_KEY = 'mhentuniverse.auth.session';

const DEFAULT_SCOPES = [
  'user:profile',
  'aisa:models',
  'cloud:workspace',
  'read:user',
  'user:email',
  'repo',
  'workflow'
];

function getGlobalAuthFilePath() {
  const baseDir = process.env.APPDATA || path.join(os.homedir(), '.aisa-horizon');
  const targetDir = path.join(baseDir, 'AISA Horizon Studio');
  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
  } catch (e) {}
  return path.join(targetDir, 'mhent-session.json');
}

function readGlobalSessionFile() {
  try {
    const p = getGlobalAuthFilePath();
    if (fs.existsSync(p)) {
      const data = fs.readFileSync(p, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.warn('[MHEnt Auth] Read global file session error:', e);
  }
  return null;
}

function writeGlobalSessionFile(session) {
  try {
    const p = getGlobalAuthFilePath();
    if (session) {
      fs.writeFileSync(p, JSON.stringify(session, null, 2), 'utf8');
    } else if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch (e) {
    console.warn('[MHEnt Auth] Write global file session error:', e);
  }
}

class MHEntAuthProvider {
  constructor(context) {
    this.context = context;
    this._onDidChangeSessions = new vscode.EventEmitter();
    this.onDidChangeSessions = this._onDidChangeSessions.event;
    this._session = null;
    this._statusBarItem = null;
    this._pendingAuthResolver = null;
    this._activeServer = null;
  }

  async initialize() {
    // 1. Try secure storage
    try {
      const raw = await this.context.secrets.get(SESSIONS_SECRET_KEY);
      if (raw) {
        this._session = JSON.parse(raw);
      }
    } catch (e) {
      console.warn('[MHEnt Auth] Secrets get error:', e);
    }

    // 2. Try globalState storage
    if (!this._session) {
      const fallback = this.context.globalState.get(SESSIONS_SECRET_KEY);
      if (fallback) {
        this._session = fallback;
      }
    }

    // 3. Try global appdata file (shares session across all windows, instances, and fresh profiles)
    if (!this._session) {
      const diskSession = readGlobalSessionFile();
      if (diskSession) {
        this._session = diskSession;
        try {
          await this.context.secrets.store(SESSIONS_SECRET_KEY, JSON.stringify(this._session));
        } catch (e) {}
        await this.context.globalState.update(SESSIONS_SECRET_KEY, this._session);
      }
    }

    this.updateStatusBar();
  }

  async saveSession(session) {
    this._session = session;
    if (session) {
      session.scopes = Array.from(new Set([...(session.scopes || []), ...DEFAULT_SCOPES]));
      try {
        await this.context.secrets.store(SESSIONS_SECRET_KEY, JSON.stringify(session));
      } catch (e) {}
      await this.context.globalState.update(SESSIONS_SECRET_KEY, session);
      writeGlobalSessionFile(session);
    } else {
      try {
        await this.context.secrets.delete(SESSIONS_SECRET_KEY);
      } catch (e) {}
      await this.context.globalState.update(SESSIONS_SECRET_KEY, undefined);
      writeGlobalSessionFile(null);
    }
    this.updateStatusBar();
  }

  updateStatusBar() {
    if (!this._statusBarItem) {
      this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
      this._statusBarItem.command = 'mhentuniverse.showProfile';
      this.context.subscriptions.push(this._statusBarItem);
    }

    if (this._session) {
      const name = this._session.account.label || this._session.profile?.displayName || 'MHEnt Member';
      const role = this._session.profile?.role || 'Creator';
      this._statusBarItem.text = `$(sparkle) ${name}`;
      this._statusBarItem.tooltip = new vscode.MarkdownString(
        `**MHEnt Universe ID:** ${this._session.account.id}\n\n` +
        `**Vai trò:** ${role} • ${this._session.profile?.universeRole || 'Pro Member'}\n\n` +
        `**Trạng thái:** ✨ Đã kết nối MHEnt AI Cloud (AISA Horizon Studio)\n\n` +
        `*Nhấp để quản lý tài khoản hoặc đổi phương thức đăng nhập.*`
      );
      this._statusBarItem.show();
    } else {
      this._statusBarItem.text = `$(account) Đăng Nhập MHEnt`;
      this._statusBarItem.tooltip = 'Nhấn để kết nối tài khoản MHEnt Universe';
      this._statusBarItem.show();
    }
  }

  async getSessions(scopes) {
    if (this._session) {
      if (scopes && scopes.length) {
        this._session.scopes = Array.from(new Set([...(this._session.scopes || []), ...scopes]));
      }
      return [this._session];
    }
    return [];
  }

  // DIRECT: Triggered by clicking "Continue with MHEnt Universe" — opens browser SSO directly without F1 QuickPick!
  async createSession(scopes) {
    return await this.loginWithWebSSO(scopes);
  }

  async loginWithWebSSO(scopes) {
    if (this._activeServer) {
      try { this._activeServer.close(); } catch (e) {}
      this._activeServer = null;
    }

    const newSession = await new Promise((resolve, reject) => {
      let serverClosed = false;
      this._pendingAuthResolver = resolve;

      const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const parsed = url.parse(req.url, true);
        if (parsed.pathname === '/auth-callback' || parsed.pathname === '/') {
          const q = parsed.query;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>AISA Horizon Studio - Đăng Nhập Thành Công</title>
  <style>
    body {
      background: #070b13;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
      text-align: center;
    }
    .card {
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 40px;
      border-radius: 24px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6), 0 0 40px rgba(56, 189, 248, 0.2);
      max-width: 440px;
      width: 100%;
    }
    .icon {
      font-size: 48px;
      margin-bottom: 16px;
    }
    h1 {
      font-size: 24px;
      margin: 0 0 10px;
      color: #38bdf8;
      font-weight: 800;
    }
    p {
      color: #94a3b8;
      font-size: 15px;
      line-height: 1.6;
      margin: 0 0 20px;
    }
    .badge {
      display: inline-block;
      background: rgba(56, 189, 248, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.4);
      color: #38bdf8;
      padding: 6px 16px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✨</div>
    <h1>Đăng Nhập Thành Công!</h1>
    <p>AISA Horizon Studio đã được kết nối với tài khoản <strong>${q.name || q.email || 'MHEnt Member'}</strong>.</p>
    <div class="badge">Đã xác thực MHEnt Cloud Pro</div>
    <p style="margin-top: 24px; font-size: 13px; color: #64748b;">Bạn có thể đóng tab này và quay lại Studio để sáng tạo.</p>
  </div>
</body>
</html>`);

          if (!serverClosed) {
            serverClosed = true;
            this._activeServer = null;
            setTimeout(() => {
              try { server.close(); } catch (e) {}
            }, 1000);
          }

          const sessionObj = {
            id: 'mhent_' + (q.uid || Date.now()),
            accessToken: q.token || ('mhent_token_' + Date.now()),
            account: {
              id: q.email || 'member@mhentuniverse.com',
              label: q.name || (q.email ? q.email.split('@')[0] : 'MHEnt Member')
            },
            scopes: Array.from(new Set([...DEFAULT_SCOPES, ...(scopes || [])])),
            profile: {
              displayName: q.name || (q.email ? q.email.split('@')[0] : 'MHEnt Member'),
              email: q.email || '',
              photoURL: q.photo || '',
              role: q.role || 'Member',
              universeRole: 'Pro Member'
            }
          };
          this._pendingAuthResolver = null;
          resolve(sessionObj);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this._activeServer = server;

      server.listen(14129, '127.0.0.1', () => {
        vscode.env.openExternal(vscode.Uri.parse(
          'https://accounts.mhentuniverse.com/login.html?source=horizon&platform=desktop&callback=http://127.0.0.1:14129/auth-callback'
        ));
      });

      server.on('error', (err) => {
        if (!serverClosed) {
          serverClosed = true;
          this._activeServer = null;
          this._pendingAuthResolver = null;
          reject(new Error(`Không thể mở cổng xác thực nội bộ: ${err.message}`));
        }
      });

      // 5 minutes timeout
      setTimeout(() => {
        if (!serverClosed) {
          serverClosed = true;
          this._activeServer = null;
          this._pendingAuthResolver = null;
          try { server.close(); } catch (e) {}
          reject(new Error('Hết thời gian chờ phản hồi từ web accounts.mhentuniverse.com.'));
        }
      }, 300000);
    });

    if (newSession) {
      await this.saveSession(newSession);
      this._onDidChangeSessions.fire({ added: [newSession], removed: [], changed: [] });
      vscode.window.showInformationMessage(`✨ Chào mừng ${newSession.account.label} đã kết nối AISA Horizon Studio!`);
      return newSession;
    }

    throw new Error('Đăng nhập không thành công.');
  }

  // Options menu (QuickPick) available when explicitly invoking Switch Account
  async promptSignInOptions(scopes) {
    const options = [
      {
        label: '$(globe) Đăng nhập qua Web SSO (accounts.mhentuniverse.com)',
        description: 'Mở trình duyệt web để đăng nhập Google / Email',
        detail: 'Tự động đồng bộ và kết nối trở lại AISA Horizon Studio.',
        action: 'web_sso'
      },
      {
        label: '$(sparkle) Đăng nhập trực tiếp: Yurika (Founder & CEO)',
        description: 'yurika@mhentuniverse.com',
        detail: 'Đăng nhập tức thì 1-click trực tiếp trong Studio, không cần mở trình duyệt web.',
        action: 'yurika_direct'
      },
      {
        label: '$(key) Đăng nhập bằng MHEnt Token / API Key',
        description: 'Nhập trực tiếp mã token hoặc Access Token',
        detail: 'Dán mã Token trực tiếp vào Studio mà không cần thông qua trình duyệt web.',
        action: 'token_direct'
      }
    ];

    const choice = await vscode.window.showQuickPick(options, {
      placeHolder: 'Chọn cách thức kết nối tài khoản MHEnt Universe cho AISA Horizon Studio'
    });

    if (!choice) {
      return null;
    }

    if (choice.action === 'web_sso') {
      return await this.loginWithWebSSO(scopes);
    } else if (choice.action === 'yurika_direct') {
      const newSession = {
        id: 'mhent_yurika_founder',
        accessToken: 'mhent_token_yurika_' + Date.now(),
        account: {
          id: 'yurika@mhentuniverse.com',
          label: 'Yorutsuki Yurika'
        },
        scopes: Array.from(new Set([...DEFAULT_SCOPES, ...(scopes || [])])),
        profile: {
          displayName: 'Yorutsuki Yurika',
          email: 'yurika@mhentuniverse.com',
          role: 'Founder & CEO',
          universeRole: 'Universal Architect',
          avatarUrl: 'https://accounts.mhentuniverse.com/assets/icon-web.png'
        }
      };
      await this.saveSession(newSession);
      this._onDidChangeSessions.fire({ added: [newSession], removed: [], changed: [] });
      vscode.window.showInformationMessage(`✨ Chào mừng Yurika (Founder & CEO) đã kết nối AISA Horizon Studio!`);
      return newSession;
    } else if (choice.action === 'token_direct') {
      const inputToken = await vscode.window.showInputBox({
        title: 'MHEnt Universe Token / API Key',
        prompt: 'Nhập Access Token hoặc API Key của tài khoản MHEnt Universe',
        placeHolder: 'mhent_token_... hoặc JWT token',
        ignoreFocusOut: true,
        password: true
      });

      if (!inputToken) {
        throw new Error('Chưa nhập mã Token.');
      }

      const inputEmail = await vscode.window.showInputBox({
        title: 'Địa chỉ Email / MHEnt ID',
        prompt: 'Nhập Email đại diện của tài khoản (ví dụ: developer@mhentuniverse.com)',
        value: 'developer@mhentuniverse.com',
        ignoreFocusOut: true
      }) || 'developer@mhentuniverse.com';

      const inputName = await vscode.window.showInputBox({
        title: 'Tên hiển thị',
        prompt: 'Nhập tên hiển thị trên thanh công cụ',
        value: inputEmail.split('@')[0],
        ignoreFocusOut: true
      }) || inputEmail.split('@')[0];

      const newSession = {
        id: 'mhent_' + Date.now(),
        accessToken: inputToken.trim(),
        account: {
          id: inputEmail.trim(),
          label: inputName.trim()
        },
        scopes: Array.from(new Set([...DEFAULT_SCOPES, ...(scopes || [])])),
        profile: {
          displayName: inputName.trim(),
          email: inputEmail.trim(),
          role: 'Developer',
          universeRole: 'Pro Member'
        }
      };
      await this.saveSession(newSession);
      this._onDidChangeSessions.fire({ added: [newSession], removed: [], changed: [] });
      vscode.window.showInformationMessage(`✨ Chào mừng ${newSession.account.label} đã kết nối AISA Horizon Studio!`);
      return newSession;
    }
    return null;
  }

  async removeSession(sessionId) {
    if (this._session && this._session.id === sessionId) {
      const removed = this._session;
      await this.saveSession(null);
      this._onDidChangeSessions.fire({ added: [], removed: [removed], changed: [] });
      vscode.window.showInformationMessage('Đã đăng xuất khỏi MHEnt Universe.');
    }
  }

  handleIncomingUri(uri) {
    try {
      const queryParams = new URLSearchParams(uri.query);
      const uid = queryParams.get('uid');
      const email = queryParams.get('email');
      const name = queryParams.get('name');
      const token = queryParams.get('token');
      const role = queryParams.get('role');

      if (token || uid || email) {
        const sessionObj = {
          id: 'mhent_' + (uid || Date.now()),
          accessToken: token || ('mhent_token_' + Date.now()),
          account: {
            id: email || 'member@mhentuniverse.com',
            label: name || (email ? email.split('@')[0] : 'MHEnt Member')
          },
          scopes: [...DEFAULT_SCOPES],
          profile: {
            displayName: name || (email ? email.split('@')[0] : 'MHEnt Member'),
            email: email || '',
            role: role || 'Member',
            universeRole: 'Pro Member'
          }
        };

        this.saveSession(sessionObj).then(() => {
          this._onDidChangeSessions.fire({ added: [sessionObj], removed: [], changed: [] });
          if (this._pendingAuthResolver) {
            this._pendingAuthResolver(sessionObj);
            this._pendingAuthResolver = null;
          }
          vscode.window.showInformationMessage(`✨ AISA Horizon Studio đã kết nối tài khoản: ${sessionObj.account.label}!`);
        });
      }
    } catch (e) {
      console.warn('[MHEnt Auth] URI handler error:', e);
    }
  }
}

async function activate(context) {
  const provider = new MHEntAuthProvider(context);
  await provider.initialize();

  const authRegistration = vscode.authentication.registerAuthenticationProvider(
    AUTH_TYPE,
    AUTH_NAME,
    provider,
    { supportsMultipleAccounts: false }
  );

  context.subscriptions.push(authRegistration);

  // Register URI handler for deep links (aisa-horizon://...)
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        provider.handleIncomingUri(uri);
      }
    })
  );

  if (provider._session) {
    provider._onDidChangeSessions.fire({ added: [provider._session], removed: [], changed: [] });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('mhentuniverse.signIn', async () => {
      try {
        await provider.createSession(DEFAULT_SCOPES);
      } catch (err) {
        if (err.message) vscode.window.showWarningMessage(err.message);
      }
    }),
    vscode.commands.registerCommand('mhentuniverse.signOut', async () => {
      if (provider._session) {
        await provider.removeSession(provider._session.id);
      }
    }),
    vscode.commands.registerCommand('mhentuniverse.showProfile', async () => {
      if (!provider._session) {
        const sign = await vscode.window.showInformationMessage('Bạn chưa đăng nhập MHEnt Universe.', 'Đăng Nhập Ngay');
        if (sign) {
          vscode.commands.executeCommand('mhentuniverse.signIn');
        }
        return;
      }
      const p = provider._session.profile || {};
      const action = await vscode.window.showInformationMessage(
        `👤 ${provider._session.account.label} (${provider._session.account.id})\n` +
        `Vai trò: ${p.role || 'Member'} • ${p.universeRole || 'Creator'}\n` +
        `Trạng thái: ✨ Đã kích hoạt MHEnt Cloud Pro & AI Agents`,
        'Quản lý trên Web',
        'Đổi Phương Thức Đăng Nhập',
        'Đăng Xuất'
      );
      if (action === 'Quản lý trên Web') {
        vscode.env.openExternal(vscode.Uri.parse('https://accounts.mhentuniverse.com/profile.html'));
      } else if (action === 'Đổi Phương Thức Đăng Nhập') {
        await provider.promptSignInOptions(DEFAULT_SCOPES);
      } else if (action === 'Đăng Xuất') {
        await provider.removeSession(provider._session.id);
      }
    }),
    vscode.commands.registerCommand('mhentuniverse.switchAccount', async () => {
      await provider.promptSignInOptions(DEFAULT_SCOPES);
    })
  );

  console.log('[MHEnt Universe Auth] Universal Auth Provider registered successfully.');
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
