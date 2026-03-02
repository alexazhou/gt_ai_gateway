import { SERVER_CONFIG } from '../config'
import { fetch } from 'undici'

/**
 * HTTP Request Helper
 * Provides convenient methods for making HTTP requests to the test server
 */

interface RequestOptions extends RequestInit {
  headers?: Record<string, string>
}

interface RequestResponse {
  ok: boolean
  status: number
  statusText: string
  body: any
  headers: Headers
}

/**
 * Make a generic HTTP request
 */
export async function request(endpoint: string, options: RequestOptions = {}): Promise<RequestResponse> {
  const url = `${SERVER_CONFIG.baseUrl}${endpoint}`

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  }

  const response = await fetch(url, {
    ...options,
    headers,
  })

  const body = await response.text()
  const parsedBody = body ? tryParseJSON(body) : body

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    body: parsedBody,
    headers: response.headers,
  }
}

/**
 * Make a GET request
 */
export async function get(endpoint: string, token?: string): Promise<RequestResponse> {
  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return request(endpoint, { method: 'GET', headers })
}

/**
 * Make a POST request
 */
export async function post(endpoint: string, body: any, token?: string): Promise<RequestResponse> {
  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return request(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

/**
 * Make a POST request with x-api-key header
 */
export async function postWithApiKey(
  endpoint: string,
  body: any,
  apiKey: string
): Promise<RequestResponse> {
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
  }
  return request(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

/**
 * Make a PUT request
 */
export async function put(endpoint: string, body: any, token?: string): Promise<RequestResponse> {
  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return request(endpoint, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  })
}

/**
 * Make a DELETE request
 */
export async function del(endpoint: string, token?: string): Promise<RequestResponse> {
  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return request(endpoint, { method: 'DELETE', headers })
}

/**
 * Try to parse JSON, return original string if failed
 */
function tryParseJSON(str: string): any {
  try {
    return JSON.parse(str)
  } catch {
    return str
  }
}
