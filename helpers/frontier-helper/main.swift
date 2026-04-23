import Darwin
import Foundation

struct HelperStatus: Codable {
    let service: String
    let status: String
    let mode: String
    let pid: Int32
    let uid: uid_t
    let euid: uid_t
    let socketPath: String?
    let startedAt: String
    let allowedVerbs: [String]
}

struct CommandResult: Codable {
    let ok: Bool
    let exitCode: Int32
    let stdout: String
    let stderr: String
}

struct ErrorResponse: Codable {
    let error: String
    let statusCode: Int
}

let startedAt = ISO8601DateFormatter().string(from: Date())
let allowedVerbs = [
    "helper.status",
    "launchd.status",
    "logs.read",
    "network.status"
]
let allowedLabels = Set([
    "ai.companion.platform.runtime",
    "com.frontier-os.frontierd",
    "com.frontier-os.ghost-shift",
    "com.frontier-os.helper",
    "com.frontier-os.nightly-research-enqueue",
    "com.frontier-os.overnight-review",
    "com.frontier-os.runpod-idle-killer",
    "com.frontier-os.work-radar"
])
let allowedRoots = [
    "/Users/test/.frontier",
    "/Users/test/Library/Logs/frontier-os",
    "/Users/test/code",
    "/Users/test/crm-analytics",
    "/Users/test/frontier-os",
    "/Library/Logs/frontier-helper.err.log",
    "/Library/Logs/frontier-helper.out.log"
]

func statusPayload(socketPath: String?) -> HelperStatus {
    HelperStatus(
        service: "frontier-helper",
        status: "ok",
        mode: socketPath == nil ? "oneshot" : "unix-socket",
        pid: getpid(),
        uid: getuid(),
        euid: geteuid(),
        socketPath: socketPath,
        startedAt: startedAt,
        allowedVerbs: allowedVerbs
    )
}

func encodeJSON<T: Encodable>(_ value: T) -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return (try? encoder.encode(value)) ?? Data("{}".utf8)
}

func writeAll(_ fd: Int32, _ data: Data) {
    data.withUnsafeBytes { rawBuffer in
        guard let base = rawBuffer.baseAddress else { return }
        var sent = 0
        while sent < data.count {
            let n = Darwin.write(fd, base.advanced(by: sent), data.count - sent)
            if n <= 0 { break }
            sent += n
        }
    }
}

func sendJSON<T: Encodable>(_ client: Int32, statusCode: Int, _ value: T) {
    let body = encodeJSON(value)
    let phrase = statusCode == 200 ? "OK" : "ERROR"
    let header = "HTTP/1.1 \(statusCode) \(phrase)\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
    writeAll(client, Data(header.utf8))
    writeAll(client, body)
}

func respond(_ client: Int32, socketPath: String) {
    var buffer = [UInt8](repeating: 0, count: 8192)
    let n = Darwin.read(client, &buffer, buffer.count)
    let request = n > 0 ? String(decoding: buffer.prefix(Int(n)), as: UTF8.self) : ""
    let firstLine = request.split(separator: "\r\n", maxSplits: 1).first ?? ""
    let parts = firstLine.split(separator: " ")
    guard parts.count >= 2, parts[0] == "GET" else {
        sendJSON(client, statusCode: 405, ErrorResponse(error: "only GET is supported", statusCode: 405))
        return
    }
    let target = String(parts[1])
    guard let components = URLComponents(string: "http://frontier-helper\(target)") else {
        sendJSON(client, statusCode: 400, ErrorResponse(error: "invalid request target", statusCode: 400))
        return
    }

    do {
        switch components.path {
        case "/", "/health", "/v1/helper/status":
            sendJSON(client, statusCode: 200, statusPayload(socketPath: socketPath))
        case "/v1/launchd/status":
            let label = query(components, "label")
            sendJSON(client, statusCode: 200, try launchdStatus(label: label))
        case "/v1/logs/read":
            let path = query(components, "path")
            let tailBytes = Int(query(components, "tailBytes") ?? "") ?? 4096
            sendJSON(client, statusCode: 200, try readLog(path: path, tailBytes: tailBytes))
        case "/v1/network/status":
            sendJSON(client, statusCode: 200, networkStatus())
        default:
            sendJSON(client, statusCode: 404, ErrorResponse(error: "unknown endpoint: \(components.path)", statusCode: 404))
        }
    } catch {
        sendJSON(client, statusCode: 403, ErrorResponse(error: String(describing: error), statusCode: 403))
    }
}

func query(_ components: URLComponents, _ name: String) -> String? {
    components.queryItems?.first(where: { $0.name == name })?.value
}

func run(_ executable: String, _ args: [String], timeoutSeconds: TimeInterval = 5) -> CommandResult {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = args
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    do {
        try process.run()
    } catch {
        return CommandResult(ok: false, exitCode: 127, stdout: "", stderr: String(describing: error))
    }
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while process.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.02)
    }
    if process.isRunning {
        process.terminate()
        return CommandResult(ok: false, exitCode: 124, stdout: "", stderr: "timeout")
    }
    let outData = stdout.fileHandleForReading.readDataToEndOfFile()
    let errData = stderr.fileHandleForReading.readDataToEndOfFile()
    return CommandResult(
        ok: process.terminationStatus == 0,
        exitCode: process.terminationStatus,
        stdout: String(data: outData, encoding: .utf8) ?? "",
        stderr: String(data: errData, encoding: .utf8) ?? ""
    )
}

func launchdStatus(label: String?) throws -> [String: String] {
    guard let label, !label.isEmpty else {
        throw NSError(domain: "frontier-helper", code: 2, userInfo: [NSLocalizedDescriptionKey: "launchd.status requires label"])
    }
    guard allowedLabels.contains(label) else {
        throw NSError(domain: "frontier-helper", code: 3, userInfo: [NSLocalizedDescriptionKey: "launchd label is not allowlisted: \(label)"])
    }
    let domain = label == "com.frontier-os.helper" ? "system/\(label)" : "gui/503/\(label)"
    let result = run("/bin/launchctl", ["print", domain])
    return [
        "label": label,
        "domain": domain,
        "loaded": result.ok ? "true" : "false",
        "exitCode": String(result.exitCode),
        "stdout": result.stdout,
        "stderr": result.stderr
    ]
}

func readLog(path: String?, tailBytes: Int) throws -> [String: String] {
    guard let path, !path.isEmpty else {
        throw NSError(domain: "frontier-helper", code: 4, userInfo: [NSLocalizedDescriptionKey: "logs.read requires path"])
    }
    let resolved = URL(fileURLWithPath: path).standardizedFileURL.path
    guard allowedRoots.contains(where: { resolved == $0 || resolved.hasPrefix($0 + "/") }) else {
        throw NSError(domain: "frontier-helper", code: 5, userInfo: [NSLocalizedDescriptionKey: "path is outside allowlisted roots: \(resolved)"])
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: resolved))
    let maxBytes = max(1, min(tailBytes, 65536))
    let tail = data.count > maxBytes ? data.suffix(maxBytes) : data
    return [
        "path": resolved,
        "sizeBytes": String(data.count),
        "returnedBytes": String(tail.count),
        "text": String(data: tail, encoding: .utf8) ?? ""
    ]
}

func networkStatus() -> CommandResult {
    run("/usr/sbin/scutil", ["--nwi"])
}

func ensureParentDirectory(for path: String) throws {
    let dir = URL(fileURLWithPath: path).deletingLastPathComponent().path
    try FileManager.default.createDirectory(
        atPath: dir,
        withIntermediateDirectories: true,
        attributes: [
            .posixPermissions: 0o755
        ]
    )
}

func serve(socketPath: String) throws -> Never {
    try ensureParentDirectory(for: socketPath)
    unlink(socketPath)

    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let maxPath = MemoryLayout.size(ofValue: addr.sun_path)
    guard socketPath.utf8.count < maxPath else {
        throw NSError(
            domain: "frontier-helper",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "socket path too long"]
        )
    }
    _ = withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
        socketPath.withCString { cstr in
            strncpy(UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: CChar.self), cstr, maxPath)
        }
    }

    let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
            Darwin.bind(fd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    if bindResult != 0 {
        close(fd)
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    chmod(socketPath, 0o666)
    if listen(fd, 16) != 0 {
        close(fd)
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }

    signal(SIGTERM) { _ in exit(0) }
    signal(SIGINT) { _ in exit(0) }

    while true {
        let client = accept(fd, nil, nil)
        if client < 0 {
            if errno == EINTR { continue }
            continue
        }
        respond(client, socketPath: socketPath)
        close(client)
    }
}

let args = CommandLine.arguments
if let socketIndex = args.firstIndex(of: "--socket"), args.count > socketIndex + 1 {
    let socketPath = args[socketIndex + 1]
    do {
        try serve(socketPath: socketPath)
    } catch {
        let payload = [
            "service": "frontier-helper",
            "status": "failed",
            "error": String(describing: error)
        ]
        FileHandle.standardError.write(encodeJSON(payload))
        FileHandle.standardError.write(Data("\n".utf8))
        exit(2)
    }
} else {
    let data = encodeJSON(statusPayload(socketPath: nil))
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}
