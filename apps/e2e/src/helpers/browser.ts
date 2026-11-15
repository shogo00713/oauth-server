/**
 * ブラウザの代わり(結合テスト用)
 *   - Cookie を、ホスト名ごとに覚える(本物のブラウザと同じ。ポートが違っても、同じ Cookie が、送られる)
 *   - リダイレクトを、追う(追う範囲は、決められる)。POST のあとの 303 は、GET に変える
 *   - 通ったレスポンスは、全部、history に残す(「秘密が、ブラウザに渡っていないか」を、あとで調べる)
 */

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const MAX_REDIRECTS = 10;

export type Page = {
    status: number;
    // 最後に見た URL
    url: string;
    headers: Headers;
    text: string;
    // 最後のレスポンスの Location(追わなかった時に、ここに残る)
    location: string | null;
    // この呼び出しの途中で出た、Set-Cookie の全部
    setCookies: string[];
    // 通った道(最後まで)
    chain: { status: number; url: string }[];
};

// リダイレクトを追うか。関数なら、「次の URL を追うか」を、1 つずつ決める
export type Follow = boolean | ((nextUrl: string) => boolean);

export type SendInit = {
    method?: string;
    // application/x-www-form-urlencoded で送る項目
    form?: Record<string, string>;
    headers?: Record<string, string>;
    follow?: Follow;
};

export type Seen = {
    url: string;
    status: number;
    headers: Headers;
    text: string;
};

export class Browser {
    // ホスト名 → (Cookie の名前 → 値)
    readonly #jar = new Map<string, Map<string, string>>();
    // 通った全てのレスポンス
    readonly history: Seen[] = [];

    cookie(url: string, name: string): string | undefined {
        return this.#jar.get(new URL(url).hostname)?.get(name);
    }

    setCookie(url: string, name: string, value: string): void {
        this.#cookiesOf(url).set(name, value);
    }

    #cookiesOf(url: string): Map<string, string> {
        const host = new URL(url).hostname;
        let cookies = this.#jar.get(host);
        if (!cookies) {
            cookies = new Map();
            this.#jar.set(host, cookies);
        }
        return cookies;
    }

    #remember(url: string, raw: string): void {
        const [pair = '', ...attributes] = raw.split(';');
        const separator = pair.indexOf('=');
        if (separator <= 0) return;
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();

        // 消す指示(Max-Age が 0 以下、または、Expires が過去)
        const isExpired = attributes.some((attribute) => {
            const [key = '', ...rest] = attribute.split('=');
            const setting = rest.join('=').trim();
            switch (key.trim().toLowerCase()) {
                case 'max-age':
                    return Number(setting) <= 0;
                case 'expires':
                    return Date.parse(setting) <= Date.now();
                default:
                    return false;
            }
        });
        if (isExpired) this.#cookiesOf(url).delete(name);
        else this.#cookiesOf(url).set(name, value);
    }

    get(url: string, init: Omit<SendInit, 'method' | 'form'> = {}) {
        return this.send(url, init);
    }

    async send(url: string, init: SendInit = {}): Promise<Page> {
        let method = init.method ?? (init.form ? 'POST' : 'GET');
        let form = init.form;
        let current = url;
        const chain: Page['chain'] = [];
        const setCookies: string[] = [];

        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const headers = new Headers(init.headers);
            const cookies = [...this.#cookiesOf(current)]
                .map(([name, value]) => `${name}=${value}`)
                .join('; ');
            if (cookies) headers.set('Cookie', cookies);

            const request: RequestInit = {
                method,
                headers,
                redirect: 'manual',
            };
            if (form) {
                headers.set(
                    'Content-Type',
                    'application/x-www-form-urlencoded',
                );
                request.body = new URLSearchParams(form).toString();
            }

            const response = await fetch(current, request);
            const text = await response.text();
            for (const raw of response.headers.getSetCookie()) {
                setCookies.push(raw);
                this.#remember(current, raw);
            }
            chain.push({ status: response.status, url: current });
            this.history.push({
                url: current,
                status: response.status,
                headers: response.headers,
                text,
            });

            const location = response.headers.get('location');
            const page: Page = {
                status: response.status,
                url: current,
                headers: response.headers,
                text,
                location,
                setCookies,
                chain,
            };
            if (!REDIRECT_STATUSES.includes(response.status) || !location) {
                return { ...page, location: null };
            }

            const next = new URL(location, current).toString();
            const follow = init.follow ?? true;
            if (!(typeof follow === 'function' ? follow(next) : follow)) {
                return { ...page, location: next };
            }

            // 303 は、いつも GET に変わる。301 と 302 も、POST は GET に変わる(ブラウザと同じ)
            if (
                response.status === 303 ||
                ((response.status === 301 || response.status === 302) &&
                    method === 'POST')
            ) {
                method = 'GET';
                form = undefined;
            }
            current = next;
        }
        throw new Error(`リダイレクトが ${MAX_REDIRECTS} 回を超えました`);
    }
}

// ---- 画面(HTML)から、読み取る ----

const ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&#34;': '"',
    '&#39;': "'",
};

// ejs が、画面に出す時に変えた文字(& < > " ')を、元に戻す
export const unescapeHtml = (html: string): string =>
    html.replace(
        /&(?:amp|lt|gt|#34|#39);/g,
        (entity) => ENTITIES[entity] ?? entity,
    );

// フォームに埋まっている CSRF のトークン
export const csrfOf = (html: string): string => {
    const token = /name="_csrf"[^>]*value="([^"]*)"/.exec(html)?.[1];
    if (!token) throw new Error('画面に、CSRF のトークンがありません');
    return token;
};

// メモ一覧の画面に出ている、メモ(上から順に)
export const memosOnPage = (html: string): { id: string; body: string }[] =>
    [
        ...html.matchAll(
            /<a class="memo-body" href="\/detail\/([^"]+)">([\s\S]*?)<\/a>/g,
        ),
    ].map(([, id = '', body = '']) => ({
        id: decodeURIComponent(id),
        body: unescapeHtml(body),
    }));

// 画面に、1 回だけ出る、メッセージ
export const flashOf = (html: string): string | undefined => {
    const text = /<p class="flash" role="status">([\s\S]*?)<\/p>/.exec(
        html,
    )?.[1];
    return text === undefined ? undefined : unescapeHtml(text);
};

// エラー画面の、メッセージ
export const errorMessageOf = (html: string): string | undefined => {
    const text = /<p id="message">([\s\S]*?)<\/p>/.exec(html)?.[1];
    return text === undefined ? undefined : unescapeHtml(text);
};
