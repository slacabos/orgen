$ErrorActionPreference = 'Stop'

try {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class OrgenCredentialStore
{
    private const uint Generic = 1;
    private const uint PersistLocalMachine = 2;
    private const int NotFound = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint BlobSize;
        public IntPtr Blob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr result);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CredWriteW(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CredDeleteW(string target, uint type, uint flags);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern void CredFree(IntPtr credential);

    public static string Read(string target)
    {
        IntPtr result;
        if (!CredReadW(target, Generic, 0, out result))
        {
            int error = Marshal.GetLastWin32Error();
            if (error == NotFound) return null;
            throw new Win32Exception(error);
        }

        try
        {
            var credential = (Credential)Marshal.PtrToStructure(result, typeof(Credential));
            if (credential.BlobSize == 0) return null;
            var bytes = new byte[credential.BlobSize];
            try
            {
                Marshal.Copy(credential.Blob, bytes, 0, bytes.Length);
                return Encoding.Unicode.GetString(bytes);
            }
            finally
            {
                Array.Clear(bytes, 0, bytes.Length);
            }
        }
        finally
        {
            CredFree(result);
        }
    }

    public static void Write(string target, string key)
    {
        if (String.IsNullOrWhiteSpace(key)) throw new ArgumentException("An API key is required.");
        var bytes = Encoding.Unicode.GetBytes(key);
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var credential = new Credential
            {
                Type = Generic,
                TargetName = target,
                UserName = "OpenRouter",
                Persist = PersistLocalMachine,
                BlobSize = (uint)bytes.Length,
                Blob = blob
            };
            if (!CredWriteW(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            Array.Clear(bytes, 0, bytes.Length);
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            Marshal.FreeHGlobal(blob);
        }
    }

    public static void Clear(string target)
    {
        if (CredDeleteW(target, Generic, 0)) return;
        int error = Marshal.GetLastWin32Error();
        if (error != NotFound) throw new Win32Exception(error);
    }
}
'@

    $operation = [Console]::ReadLine()
    $target = [Console]::ReadLine()
    switch -CaseSensitive ($operation) {
        'get' {
            $key = [OrgenCredentialStore]::Read($target)
            if ([string]::IsNullOrWhiteSpace($key)) { exit 3 }
            [Console]::Out.Write($key)
        }
        'set' {
            [OrgenCredentialStore]::Write($target, [Console]::ReadLine())
        }
        'clear' {
            [OrgenCredentialStore]::Clear($target)
        }
        default {
            exit 1
        }
    }
} catch {
    [Console]::Error.WriteLine('Windows Credential Manager operation failed.')
    exit 1
}
