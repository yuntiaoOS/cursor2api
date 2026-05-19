// ==================== Anthropic API Types ====================

export interface AnthropicRequest {
    model: string;
    messages: AnthropicMessage[];
    max_tokens: number;
    stream?: boolean;
    system?: string | AnthropicContentBlock[];
    tools?: AnthropicTool[];
    tool_choice?: AnthropicToolChoice;
    temperature?: number;
    top_p?: number;
    stop_sequences?: string[];
    thinking?: { type: 'enabled' | 'disabled' | 'adaptive'; budget_tokens?: number };
    metadata?: { user_id?: string; [key: string]: unknown };
}

/** Cursor Cloud Agents API (api.cursor.com/v1/agents) */
export interface CloudAgentConfig {
    enabled: boolean;
    apiBase: string;
    repoUrl?: string;
    startingRef?: string;
    envType?: 'cloud' | 'pool' | 'machine';
    envName?: string;
    model: string;
    modelParams?: Array<{ id: string; value: string }>;
    readTimeoutSec: number;
    agentBusyRetries: number;
    agentBusyDelaySec: number;
    streamResumeRetries: number;
    sessionTtlSec: number;
}

/** tool_choice 鎺у埗妯″瀷鏄惁蹇呴』璋冪敤宸ュ叿
 *  - auto: 妯″瀷鑷鍐冲畾锛堥粯璁わ級
 *  - any:  蹇呴』璋冪敤鑷冲皯涓€涓伐鍏?
 *  - tool: 蹇呴』璋冪敤鎸囧畾宸ュ叿
 */
export type AnthropicToolChoice =
    | { type: 'auto' }
    | { type: 'any' }
    | { type: 'tool'; name: string };

export interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
    type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'thinking';
    text?: string;
    thinking?: string;
    // image fields
    source?: { type: string; media_type?: string; data: string; url?: string };
    // tool_use fields
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    // tool_result fields
    tool_use_id?: string;
    content?: string | AnthropicContentBlock[];
    is_error?: boolean;
}

export interface AnthropicTool {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}

export interface AnthropicResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: string;
    stop_sequence: string | null;
    usage: { input_tokens: number; output_tokens: number };
}

// ==================== Cursor API Types ====================

export interface CursorChatRequest {
    context?: CursorContext[];
    model: string;
    id: string;
    messages: CursorMessage[];
    trigger: string;
}

export interface CursorContext {
    type: string;
    content: string;
    filePath: string;
}

export interface CursorMessage {
    parts: CursorPart[];
    id: string;
    role: string;
}

export interface CursorPart {
    type: string;
    text: string;
}

export interface CursorSSEEvent {
    type: string;
    delta?: string;
    finishReason?: string;
    messageMetadata?: {
        usage?: {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
        };
    };
}

// ==================== Internal Types ====================

export interface ParsedToolCall {
    name: string;
    arguments: Record<string, unknown>;
}

export interface AppConfig {
    port: number;
    timeout: number;
    proxy?: string;
    cursorModel: string;
    authTokens?: string[];  // API 閴存潈 token 鍒楄〃锛屼负绌哄垯涓嶉壌鏉?
    maxAutoContinue: number;        // 鑷姩缁啓鏈€澶ф鏁帮紝榛樿 3锛岃 0 绂佺敤
    maxHistoryMessages: number;     // 鍘嗗彶娑堟伅鏉℃暟纭檺鍒讹紝榛樿 -1锛堜笉闄愬埗锛?
    maxHistoryTokens: number;       // 鍘嗗彶娑堟伅 token 鏁颁笂闄愶紙tiktoken 浼扮畻鎴戜滑鍙戝嚭鐨勫唴瀹癸紝浠ｇ爜鑷姩鍔?Cursor 鍚庣寮€閿€锛?300 鍩虹 + perTool*宸ュ叿鏁帮級锛岄粯璁?150000锛?1 涓嶉檺鍒?
    vision?: {
        enabled: boolean;
        mode: 'ocr' | 'api';
        baseUrl: string;
        apiKey: string;
        model: string;
        proxy?: string;  // vision 鐙珛浠ｇ悊锛堜笉褰卞搷 Cursor API 鐩磋繛锛?
    };
    compression?: {
        enabled: boolean;          // 鏄惁鍚敤鍘嗗彶娑堟伅鍘嬬缉
        level: 1 | 2 | 3;         // 鍘嬬缉绾у埆: 1=杞诲害, 2=涓瓑(榛樿), 3=婵€杩?
        keepRecent: number;        // 淇濈暀鏈€杩?N 鏉℃秷鎭笉鍘嬬缉
        earlyMsgMaxChars: number;  // 鏃╂湡娑堟伅鏈€澶у瓧绗︽暟
    };
    thinking?: {
        enabled: boolean;          // 鏄惁鍚敤 thinking锛堟渶楂樹紭鍏堢骇锛岃鐩栧鎴风璇锋眰锛?
    };
    logging?: {
        file_enabled: boolean;     // 鏄惁鍚敤鏃ュ織鏂囦欢鎸佷箙鍖?
        dir: string;               // 鏃ュ織鏂囦欢瀛樺偍鐩綍
        max_days: number;          // 鏃ュ織淇濈暀澶╂暟
        persist_mode: 'compact' | 'full' | 'summary'; // 钀界洏妯″紡: compact=绮剧畝, full=瀹屾暣, summary=浠呴棶绛旀憳瑕?
        db_enabled: boolean;       // 鏄惁鍚敤 SQLite 瀛樺偍
        db_path: string;           // SQLite 鏂囦欢璺緞锛岄粯璁?'./logs/cursor2api.db'
    };
    tools?: {
        schemaMode: 'compact' | 'full' | 'names_only';  // Schema 鍛堢幇妯″紡
        descriptionMaxLength: number;                     // 鎻忚堪鎴柇闀垮害 (0=涓嶆埅鏂?
        includeOnly?: string[];                           // 鐧藉悕鍗曪細鍙繚鐣欑殑宸ュ叿鍚?
        exclude?: string[];                               // 榛戝悕鍗曪細瑕佹帓闄ょ殑宸ュ叿鍚?
        passthrough?: boolean;                            // 閫忎紶妯″紡锛氳烦杩?few-shot 娉ㄥ叆锛岀洿鎺ュ祵鍏ュ伐鍏峰畾涔?
        disabled?: boolean;                               // 绂佺敤妯″紡锛氬畬鍏ㄤ笉娉ㄥ叆宸ュ叿瀹氫箟锛屾渶澶у寲鑺傜渷涓婁笅鏂?
        adaptiveBudget?: boolean;                         // 鑷€傚簲鍘嗗彶棰勭畻锛氭牴鎹伐鍏锋暟閲忚嚜鍔ㄦ敹绱у巻鍙?token 棰勭畻
        smartTruncation?: boolean;                        // 鏅鸿兘鎴柇锛氭寜宸ュ叿绫诲瀷宸紓鍖栨埅鏂粨鏋滐紙Read/Bash/Search 鍚勭敤涓嶅悓绛栫暐锛?
    };
    sanitizeEnabled: boolean;    // 鏄惁鍚敤鍝嶅簲鍐呭娓呮礂锛堟浛鎹?Cursor 韬唤寮曠敤涓?Claude锛夛紝榛樿 false
    contextPressure?: number;    // 涓婁笅鏂囧帇鍔涜啫鑳€绯绘暟锛堥粯璁?1.35锛夛紝铏氬 input_tokens 璁╁鎴风鎻愬墠鍘嬬缉
    refusalPatterns?: string[];  // 鑷畾涔夋嫆缁濇娴嬭鍒欙紙杩藉姞鍒板唴缃垪琛ㄤ箣鍚庯級
    systemPrompt?: string;     // 鑷畾涔夌郴缁熸彁绀鸿瘝锛岃鐩?Cursor 鍐呯疆鐨勬枃妗ｅ姪鎵嬭韩浠?
    sessionToken?: string;     // Cursor 浼氳瘽 token锛坈rsr_ 鎴?WorkosCursorSessionToken 鍊硷級锛屽悎骞惰繘 cookie
    apiKey?: string;          // Cursor Dashboard API key (crsr_* for Cloud Agent Basic auth; Bearer for docs /api/chat)
    cloudAgent?: CloudAgentConfig;
    cookie?: string;           // Cursor 璇锋眰鎼哄甫鐨?Cookie锛堢敤浜庨€氳繃 Vercel 瀹夊叏楠岃瘉锛屽彲鍚?_vcrcs锛?
    stealthProxy?: string;     // Stealth 浠ｇ悊鍦板潃锛堝 http://stealth-proxy:3011锛夛紝閰嶇疆鍚庨€氳繃鏃犲ご娴忚鍣ㄨ浆鍙戣姹?
    fingerprint: {
        userAgent: string;
    };
}
