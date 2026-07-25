#include <node_api.h>
#include <windows.h>
#include <wincrypt.h>
#include <aclapi.h>

#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr size_t kMaxDpapiBufferBytes = 64 * 1024;
const char kEntropy[] = "Relaybase.OpenRouter.Credential.v1";

void Throw(napi_env env, const char* code, const char* message) {
  napi_value error_message;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &error_message);
  napi_value error;
  napi_create_error(env, nullptr, error_message, &error);
  napi_value error_code;
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &error_code);
  napi_set_named_property(env, error, "code", error_code);
  napi_throw(env, error);
}

bool ReadBuffer(napi_env env, napi_callback_info info, void** data, size_t* length) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) {
    Throw(env, "ERR_RELAYBASE_DPAPI_ARGUMENT", "Expected one Buffer argument.");
    return false;
  }
  bool is_buffer = false;
  if (napi_is_buffer(env, args[0], &is_buffer) != napi_ok || !is_buffer) {
    Throw(env, "ERR_RELAYBASE_DPAPI_ARGUMENT", "Expected a Buffer argument.");
    return false;
  }
  if (napi_get_buffer_info(env, args[0], data, length) != napi_ok || *length == 0 ||
      *length > kMaxDpapiBufferBytes) {
    Throw(env, "ERR_RELAYBASE_DPAPI_SIZE", "Credential Buffer size is outside supported bounds.");
    return false;
  }
  return true;
}

napi_value ProtectCurrentUser(napi_env env, napi_callback_info info) {
  void* input_data = nullptr;
  size_t input_length = 0;
  if (!ReadBuffer(env, info, &input_data, &input_length)) {
    return nullptr;
  }

  DATA_BLOB input{static_cast<DWORD>(input_length), static_cast<BYTE*>(input_data)};
  DATA_BLOB entropy{
      static_cast<DWORD>(sizeof(kEntropy) - 1),
      reinterpret_cast<BYTE*>(const_cast<char*>(kEntropy))};
  DATA_BLOB output{};
  if (!CryptProtectData(
          &input,
          L"Relaybase OpenRouter credential",
          &entropy,
          nullptr,
          nullptr,
          CRYPTPROTECT_UI_FORBIDDEN,
          &output)) {
    Throw(env, "ERR_RELAYBASE_DPAPI_PROTECT", "Windows DPAPI could not protect the credential.");
    return nullptr;
  }

  napi_value result;
  const napi_status status = napi_create_buffer_copy(env, output.cbData, output.pbData, nullptr, &result);
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  if (status != napi_ok) {
    Throw(env, "ERR_RELAYBASE_DPAPI_ALLOC", "Could not allocate the protected credential Buffer.");
    return nullptr;
  }
  return result;
}

napi_value UnprotectCurrentUser(napi_env env, napi_callback_info info) {
  void* input_data = nullptr;
  size_t input_length = 0;
  if (!ReadBuffer(env, info, &input_data, &input_length)) {
    return nullptr;
  }

  DATA_BLOB input{static_cast<DWORD>(input_length), static_cast<BYTE*>(input_data)};
  DATA_BLOB entropy{
      static_cast<DWORD>(sizeof(kEntropy) - 1),
      reinterpret_cast<BYTE*>(const_cast<char*>(kEntropy))};
  DATA_BLOB output{};
  if (!CryptUnprotectData(
          &input,
          nullptr,
          &entropy,
          nullptr,
          nullptr,
          CRYPTPROTECT_UI_FORBIDDEN,
          &output)) {
    Throw(env, "ERR_RELAYBASE_DPAPI_UNPROTECT", "Windows DPAPI could not decrypt the credential.");
    return nullptr;
  }
  if (output.cbData == 0 || output.cbData > kMaxDpapiBufferBytes) {
    SecureZeroMemory(output.pbData, output.cbData);
    LocalFree(output.pbData);
    Throw(env, "ERR_RELAYBASE_DPAPI_SIZE", "Decrypted credential size is outside supported bounds.");
    return nullptr;
  }

  napi_value result;
  const napi_status status = napi_create_buffer_copy(env, output.cbData, output.pbData, nullptr, &result);
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  if (status != napi_ok) {
    Throw(env, "ERR_RELAYBASE_DPAPI_ALLOC", "Could not allocate the decrypted credential Buffer.");
    return nullptr;
  }
  return result;
}

napi_value CheckUserVerificationAvailability(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_object(env, &result);
  napi_value available;
  napi_get_boolean(env, false, &available);
  napi_set_named_property(env, result, "available", available);
  napi_value reason;
  napi_create_string_utf8(
      env,
      "windows_verification_requires_interactive_host_support",
      NAPI_AUTO_LENGTH,
      &reason);
  napi_set_named_property(env, result, "reason", reason);
  return result;
}

napi_value RequestUserVerification(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, false, &result);
  return result;
}

bool ReadPath(napi_env env, napi_callback_info info, std::vector<char16_t>* path) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) {
    Throw(env, "ERR_RELAYBASE_ACL_ARGUMENT", "Expected one path argument.");
    return false;
  }
  size_t path_length = 0;
  if (napi_get_value_string_utf16(env, args[0], nullptr, 0, &path_length) != napi_ok || path_length == 0 ||
      path_length > 32767) {
    Throw(env, "ERR_RELAYBASE_ACL_ARGUMENT", "Expected a valid Windows path.");
    return false;
  }
  path->resize(path_length + 1);
  if (napi_get_value_string_utf16(env, args[0], path->data(), path->size(), &path_length) != napi_ok) {
    Throw(env, "ERR_RELAYBASE_ACL_ARGUMENT", "Could not read the Windows path.");
    return false;
  }
  return true;
}

bool ResolveCurrentUserAndSystem(
    napi_env env,
    HANDLE* resolved_token,
    std::vector<BYTE>* token_buffer,
    std::vector<BYTE>* system_sid_buffer,
    PSID* user_sid,
    PSID* system_sid) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    Throw(env, "ERR_RELAYBASE_ACL_TOKEN", "Could not inspect the current Windows user token.");
    return false;
  }
  DWORD token_bytes = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &token_bytes);
  token_buffer->resize(token_bytes);
  if (!GetTokenInformation(token, TokenUser, token_buffer->data(), token_bytes, &token_bytes)) {
    CloseHandle(token);
    Throw(env, "ERR_RELAYBASE_ACL_TOKEN", "Could not resolve the current Windows user.");
    return false;
  }
  *user_sid = reinterpret_cast<TOKEN_USER*>(token_buffer->data())->User.Sid;

  DWORD system_sid_bytes = SECURITY_MAX_SID_SIZE;
  system_sid_buffer->resize(system_sid_bytes);
  if (!CreateWellKnownSid(
          WinLocalSystemSid, nullptr, system_sid_buffer->data(), &system_sid_bytes)) {
    CloseHandle(token);
    Throw(env, "ERR_RELAYBASE_ACL_SYSTEM_SID", "Could not resolve Windows SYSTEM authority.");
    return false;
  }
  *system_sid = static_cast<PSID>(system_sid_buffer->data());
  *resolved_token = token;
  return true;
}

napi_value RestrictPathToCurrentUser(napi_env env, napi_callback_info info) {
  std::vector<char16_t> path;
  if (!ReadPath(env, info, &path)) {
    return nullptr;
  }
  HANDLE token = nullptr;
  std::vector<BYTE> token_buffer;
  std::vector<BYTE> system_sid_buffer;
  PSID user_sid = nullptr;
  PSID system_sid = nullptr;
  if (!ResolveCurrentUserAndSystem(
          env, &token, &token_buffer, &system_sid_buffer, &user_sid, &system_sid)) {
    return nullptr;
  }

  EXPLICIT_ACCESSW entries[2]{};
  entries[0].grfAccessPermissions = GENERIC_ALL;
  entries[0].grfAccessMode = SET_ACCESS;
  entries[0].grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  entries[0].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entries[0].Trustee.TrusteeType = TRUSTEE_IS_USER;
  entries[0].Trustee.ptstrName = static_cast<LPWSTR>(user_sid);
  entries[1].grfAccessPermissions = GENERIC_ALL;
  entries[1].grfAccessMode = SET_ACCESS;
  entries[1].grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  entries[1].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entries[1].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  entries[1].Trustee.ptstrName = reinterpret_cast<LPWSTR>(system_sid);

  PACL acl = nullptr;
  const DWORD acl_result = SetEntriesInAclW(2, entries, nullptr, &acl);
  if (acl_result != ERROR_SUCCESS) {
    CloseHandle(token);
    Throw(env, "ERR_RELAYBASE_ACL_BUILD", "Could not build the credential file access policy.");
    return nullptr;
  }
  const DWORD set_result = SetNamedSecurityInfoW(
      reinterpret_cast<LPWSTR>(path.data()),
      SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr,
      nullptr,
      acl,
      nullptr);
  LocalFree(acl);
  CloseHandle(token);
  if (set_result != ERROR_SUCCESS) {
    Throw(env, "ERR_RELAYBASE_ACL_APPLY", "Could not restrict the credential path to the current user.");
    return nullptr;
  }
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

napi_value IsPathRestrictedToCurrentUser(napi_env env, napi_callback_info info) {
  std::vector<char16_t> path;
  if (!ReadPath(env, info, &path)) {
    return nullptr;
  }
  HANDLE token = nullptr;
  std::vector<BYTE> token_buffer;
  std::vector<BYTE> system_sid_buffer;
  PSID user_sid = nullptr;
  PSID system_sid = nullptr;
  if (!ResolveCurrentUserAndSystem(
          env, &token, &token_buffer, &system_sid_buffer, &user_sid, &system_sid)) {
    return nullptr;
  }

  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD get_result = GetNamedSecurityInfoW(
      reinterpret_cast<LPWSTR>(path.data()),
      SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION,
      nullptr,
      nullptr,
      &dacl,
      nullptr,
      &descriptor);
  if (get_result != ERROR_SUCCESS || descriptor == nullptr || dacl == nullptr) {
    CloseHandle(token);
    if (descriptor != nullptr) {
      LocalFree(descriptor);
    }
    Throw(env, "ERR_RELAYBASE_ACL_INSPECT", "Could not inspect the credential path access policy.");
    return nullptr;
  }

  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  bool restricted =
      GetSecurityDescriptorControl(descriptor, &control, &revision) &&
      (control & SE_DACL_PROTECTED) != 0;
  bool user_allow = false;
  bool system_allow = false;
  for (DWORD index = 0; restricted && index < dacl->AceCount; ++index) {
    void* raw_ace = nullptr;
    if (!GetAce(dacl, index, &raw_ace) || raw_ace == nullptr) {
      restricted = false;
      break;
    }
    ACE_HEADER* header = static_cast<ACE_HEADER*>(raw_ace);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) {
      continue;
    }
    ACCESS_ALLOWED_ACE* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw_ace);
    PSID sid = static_cast<PSID>(&ace->SidStart);
    if (EqualSid(sid, user_sid)) {
      user_allow = true;
    } else if (EqualSid(sid, system_sid)) {
      system_allow = true;
    } else {
      restricted = false;
    }
  }
  restricted = restricted && user_allow && system_allow;

  LocalFree(descriptor);
  CloseHandle(token);
  napi_value result;
  napi_get_boolean(env, restricted, &result);
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"protectCurrentUser", nullptr, ProtectCurrentUser, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"unprotectCurrentUser", nullptr, UnprotectCurrentUser, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"checkUserVerificationAvailability",
       nullptr,
       CheckUserVerificationAvailability,
       nullptr,
       nullptr,
       nullptr,
       napi_default,
       nullptr},
      {"requestUserVerification",
       nullptr,
       RequestUserVerification,
       nullptr,
       nullptr,
       nullptr,
       napi_default,
       nullptr},
      {"restrictPathToCurrentUser",
       nullptr,
       RestrictPathToCurrentUser,
       nullptr,
       nullptr,
       nullptr,
       napi_default,
       nullptr},
      {"isPathRestrictedToCurrentUser",
       nullptr,
       IsPathRestrictedToCurrentUser,
       nullptr,
       nullptr,
       nullptr,
       napi_default,
       nullptr}};
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
