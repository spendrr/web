import { describe, expect, it } from "vitest";
import { escapeHtml, profileMeta, profileMetaTags } from "../worker/profileMeta";

describe("escapeHtml", () => {
  it("escapes everything that could close an attribute or open a tag", () => {
    expect(escapeHtml(`a&b<c>"d'e`)).toBe("a&amp;b&lt;c&gt;&quot;d&#39;e");
  });
});

describe("profileMeta", () => {
  it("names the profile and links to the same spelling people share", () => {
    const m = profileMeta("pavel", "https://spendrr.app");
    expect(m.title).toBe("@pavel na Spendrr");
    expect(m.url).toBe("https://spendrr.app/@pavel");
    expect(m.description).toContain("@pavel");
    expect(m.image).toBe("https://spendrr.app/icon-512.png");
    expect(m.imageSize).toBeNull();
  });

  it("uses the address's avatar as the picture when there is one", () => {
    const m = profileMeta("pavel", "https://spendrr.app", { address: "ark1abc", lnAddress: false });
    expect(m.image).toBe("https://spendrr.app/api/avatar/ark1abc.png");
    expect(m.imageSize).toBe(256);
    expect(profileMetaTags(m)).toContain('og:image:width" content="256"');
  });

  it("leads with the Lightning address once the owner turned it on", () => {
    const m = profileMeta("pavel", "https://spendrr.app", { address: null, lnAddress: true });
    expect(m.title).toBe("pavel@spendrr.app");
    expect(m.description).toContain("@pavel");
  });
});

describe("profileMetaTags", () => {
  it("emits the Open Graph and Twitter tags", () => {
    const html = profileMetaTags(profileMeta("pavel", "https://spendrr.app"));
    for (const needle of ["og:title", "og:description", "og:url", "og:image", "twitter:card", "twitter:title", 'rel="canonical"']) {
      expect(html).toContain(needle);
    }
  });

  it("cannot be used to inject markup, whatever it is handed", () => {
    const html = profileMetaTags({
      title: `"><script>alert(1)</script>`,
      description: `<img src=x onerror=alert(1)>`,
      url: `https://x/"onload="alert(1)`,
      image: `javascript:"><b>`,
      imageSize: null,
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('"onload=');
    // every attribute value stays inside its quotes: an even number of quote characters per tag
    for (const tag of html.split(">").filter(Boolean)) {
      expect((tag.match(/"/g) ?? []).length % 2).toBe(0);
    }
  });
});
