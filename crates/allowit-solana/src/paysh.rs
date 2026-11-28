//! Read-only source of pay.sh listings for the marketplace. The registry's production x402
//! listings are for Solana Mainnet. Use the seller's live challenge to verify payment terms.
use allowit_core::{
    transport::{
        http::{HttpClient, Method, Request},
        rpc::Options,
    },
    vendor::{
        error::{Error, Result},
        paid_service::{
            AccessKind, CatalogAccess, CatalogEntry, CatalogSource, MAX_QUERY_BYTES, resource_url,
        },
    },
};
use serde::{Deserialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, time::Duration};

const INDEX: &str = "https://pay.sh/api/catalog";
// Use the published detail origin instead of trusting the index's base_url.
const DETAILS: &str = "https://storage.googleapis.com/pay-skills/v1/providers";
const MAINNET: &str = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/// A provider found in the public index. The caller chooses which details to load.
#[derive(Debug, Deserialize)]
pub struct Provider {
    fqn: String,
    title: String,
    description: String,
    #[serde(default)]
    use_case: String,
    category: String,
    service_url: String,
}

impl Provider {
    pub fn id(&self) -> &str {
        &self.fqn
    }

    fn matches(&self, query: &str) -> bool {
        let text = format!(
            "{} {} {} {} {}",
            self.fqn, self.title, self.description, self.use_case, self.category
        )
        .to_lowercase();
        query.split_whitespace().all(|word| text.contains(word))
    }
}

#[derive(Deserialize)]
struct Index {
    version: u64,
    providers: Vec<Provider>,
}

#[derive(Deserialize)]
struct Detail {
    fqn: String,
    service_url: String,
    endpoints: Vec<Endpoint>,
}

#[derive(Deserialize)]
struct Endpoint {
    method: String,
    path: String,
    description: String,
    #[serde(default)]
    protocol: Vec<String>,
    #[serde(default)]
    probe_status: String,
}

/// The rail's pay.sh catalog source. Fetches only the public index and provider documents.
pub struct Source(HttpClient);

impl Source {
    pub fn new() -> Result<Self> {
        HttpClient::new(Options {
            timeout: Duration::from_secs(10),
            max_response_bytes: 8 * 1024 * 1024,
            no_proxy: false,
            connect_timeout: None,
        })
        .map(Self)
        .map_err(|_| Error::config("Cannot initialize the pay.sh catalog transport"))
    }

    /// Search provider names, descriptions, use cases and categories. An empty query lists all.
    pub fn providers(&self, query: &str) -> Result<Vec<Provider>> {
        if query.len() > MAX_QUERY_BYTES || query.chars().any(char::is_control) {
            return Err(Error::usage("The pay.sh catalog search text is invalid"));
        }
        let index: Index = self.get(INDEX)?;
        index.search(query)
    }

    /// Read a provider's endpoint listings and convert its x402 offers to Core marketplace entries.
    pub fn offers(&self, provider: &Provider) -> Result<Vec<CatalogEntry>> {
        if !valid_fqn(provider.id()) {
            return Err(Error::usage("The pay.sh provider ID is invalid"));
        }
        let url = format!("{DETAILS}/{}.json", provider.id());
        provider.offers(self.get(&url)?, &url)
    }

    fn get<T: DeserializeOwned>(&self, url: &str) -> Result<T> {
        let response = self
            .0
            .send_success_body(
                Request {
                    method: Method::Get,
                    url,
                    headers: &[],
                    body: None,
                },
                None,
            )
            .map_err(|_| Error::uncertain("The pay.sh catalog request failed"))?;
        if response.status != 200 {
            return Err(Error::uncertain(format!(
                "The pay.sh catalog returned HTTP {}",
                response.status
            )));
        }
        serde_json::from_slice(&response.body)
            .map_err(|_| Error::uncertain("The pay.sh catalog returned an invalid document"))
    }
}

impl Index {
    fn search(self, query: &str) -> Result<Vec<Provider>> {
        if self.version != 2 {
            return Err(Error::uncertain(
                "The pay.sh catalog version is unsupported",
            ));
        }
        let query = query.to_lowercase();
        let mut matches = BTreeMap::new();
        for provider in self.providers {
            if valid_fqn(provider.id()) && provider.matches(&query) {
                matches.entry(provider.fqn.clone()).or_insert(provider);
            }
        }
        Ok(matches.into_values().collect())
    }
}

fn valid_fqn(fqn: &str) -> bool {
    (2..=3).contains(&fqn.split('/').count())
        && fqn.len() <= 128
        && fqn.split('/').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

impl Provider {
    fn offers(&self, detail: Detail, captured: &str) -> Result<Vec<CatalogEntry>> {
        if detail.fqn != self.fqn || detail.service_url != self.service_url {
            return Err(Error::uncertain(
                "The pay.sh provider detail differs from its index",
            ));
        }
        let base = self.service_url.trim_end_matches('/');
        if !base.starts_with("https://") || base.contains(['?', '#', '\\']) {
            return Err(Error::uncertain("The pay.sh provider URL is invalid"));
        }
        resource_url(base).map_err(|_| Error::uncertain("The pay.sh provider URL is invalid"))?;
        let mut entries = BTreeMap::new();
        for endpoint in detail.endpoints {
            if let Some(entry) = self.entry(endpoint, base, captured) {
                entries.entry(entry.id.clone()).or_insert(entry);
            }
        }
        Ok(entries.into_values().collect())
    }

    fn entry(&self, endpoint: Endpoint, base: &str, captured: &str) -> Option<CatalogEntry> {
        // pay.sh's production probe records x402 only when it sees a Solana payment option.
        if endpoint.probe_status != "ok"
            || !endpoint.protocol.iter().any(|protocol| protocol == "x402")
        {
            return None;
        }
        let method = endpoint.method.to_ascii_uppercase();
        if !matches!(
            method.as_str(),
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
        ) {
            return None;
        }
        let path = endpoint.path.trim_start_matches('/');
        // A marketplace entry carries a concrete resource. Templated routes need caller input.
        if path.contains(['{', '}', '#', '?', '\\'])
            || path.split('/').any(|segment| matches!(segment, "." | ".."))
        {
            return None;
        }
        let resource = if path.is_empty() {
            base.to_owned()
        } else {
            format!("{base}/{path}")
        };
        resource_url(&resource).ok()?;
        let name = listing_text(&self.title, 200);
        if name.is_empty() {
            return None;
        }
        let category = listing_text(&self.category, 64);
        let digest = Sha256::digest(format!("{method} {resource}").as_bytes());
        let id = format!("paysh:{}:{digest:x}", self.fqn);
        Some(CatalogEntry {
            id,
            name,
            description: listing_text(&endpoint.description, 2000),
            provider: self.fqn.clone(),
            resource,
            methods: vec![method],
            terms: None,
            networks: vec![MAINNET.into()],
            assets: Vec::new(),
            tags: Some(category)
                .filter(|value| !value.is_empty())
                .into_iter()
                .collect(),
            source: Some(CatalogSource {
                listing: None,
                captured: Some(captured.into()),
            }),
            operation: None,
            access: vec![CatalogAccess {
                kind: AccessKind::Payment,
                protocol: Some("x402".into()),
                scheme: None,
                network: Some(MAINNET.into()),
                asset: None,
                detail: None,
            }],
            observed: Vec::new(),
            reputation: None,
            rank: None,
        })
    }
}

fn listing_text(text: &str, max: usize) -> String {
    let mut text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    text.retain(|character| !character.is_control());
    text.truncate(text.floor_char_boundary(max));
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROVIDER: &str = r#"{
        "fqn": "example/team/search",
        "title": "Search API",
        "description": "Find data",
        "use_case": "Look up venues",
        "category": "data",
        "service_url": "https://search.example.com/v1/"
    }"#;

    #[test]
    fn provider_search_uses_catalog_metadata_and_valid_ids() {
        let body = format!(
            r#"{{"version":2,"providers":[{PROVIDER},{PROVIDER},{}]}}"#,
            PROVIDER.replace("example/team/search", "example/../search")
        );
        let found = serde_json::from_str::<Index>(&body)
            .unwrap()
            .search("VENUES data")
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id(), "example/team/search");
        assert!(!valid_fqn("example/%2e%2e/search"));
    }

    #[test]
    fn offers_carry_the_production_network_and_a_concrete_resource() {
        let provider: Provider = serde_json::from_str(PROVIDER).unwrap();
        let detail: Detail = serde_json::from_str(
            r#"{
                "fqn":"example/team/search",
                "service_url":"https://search.example.com/v1/",
                "endpoints":[
                    {"method":"post","path":"/search","description":"Find\nvenues","probe_status":"ok","protocol":["x402"]},
                    {"method":"GET","path":"free","description":"Free","probe_status":"free"},
                    {"method":"POST","path":"mpp","description":"MPP","probe_status":"ok","protocol":["mpp"]},
                    {"method":"GET","path":"items/{id}","description":"Templated","probe_status":"ok","protocol":["x402"]}
                ]
            }"#,
        )
        .unwrap();
        let entries = provider.offers(detail, INDEX).unwrap();
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.resource, "https://search.example.com/v1/search");
        assert_eq!(entry.description, "Find venues");
        assert_eq!(entry.methods, ["POST"]);
        assert_eq!(entry.networks, [MAINNET]);
        assert_eq!(entry.access[0].network.as_deref(), Some(MAINNET));
        assert_eq!(entry.access[0].protocol.as_deref(), Some("x402"));
    }

    #[test]
    #[ignore = "reads the public pay.sh registry"]
    fn live_registry_exposes_a_mainnet_offer() {
        let source = Source::new().unwrap();
        let provider = source
            .providers("blockrun")
            .unwrap()
            .into_iter()
            .find(|provider| provider.id() == "blockrun/blockrun")
            .unwrap();
        let entries = source.offers(&provider).unwrap();
        assert!(entries.iter().any(|entry| entry.networks == [MAINNET]));
    }
}
