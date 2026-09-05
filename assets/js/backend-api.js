/* ═══════════════════════════════════════════════════════════════
   CKA BuildStruct — backend-api.js
   Typed-by-convention client facade over the production Supabase backend.

   This file contains NO authorization decisions. PostgreSQL grants, RLS and
   RPC authorization remain the source of truth. It only gives the frontend a
   stable contract instead of scattering raw table/RPC calls across pages.
   Requires assets/js/store.js to be loaded first.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  function supabaseClient() {
    const client = global.CKAStore && global.CKAStore.supabase;
    if (!client) throw new Error("CKA backend is unavailable. Load store.js before backend-api.js.");
    return client;
  }

  async function rpc(name, args) {
    const { data, error } = await supabaseClient().rpc(name, args || {});
    if (error) throw error;
    return data;
  }

  async function rows(table, options) {
    const opts = options || {};
    let query = supabaseClient().from(table).select(opts.select || "*");

    if (Array.isArray(opts.eq)) {
      opts.eq.forEach(([column, value]) => { query = query.eq(column, value); });
    }
    if (opts.order) {
      query = query.order(opts.order.column, { ascending: opts.order.ascending !== false });
    }
    if (Number.isInteger(opts.limit) && opts.limit > 0) query = query.limit(opts.limit);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function currentProfile() {
    const client = supabaseClient();
    const { data: auth, error: authError } = await client.auth.getUser();
    if (authError) throw authError;
    if (!auth || !auth.user) return null;

    const { data, error } = await client
      .from("profiles")
      .select("id,role,full_name,email,phone")
      .eq("id", auth.user.id)
      .single();
    if (error) throw error;
    return data;
  }

  function channelName(prefix) {
    const suffix = global.crypto && typeof global.crypto.randomUUID === "function"
      ? global.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
    return `${prefix}-${suffix}`;
  }

  function subscribeTo(table, callback, filter) {
    if (typeof callback !== "function") throw new Error("A Realtime callback is required.");
    const client = supabaseClient();
    const config = { event: "*", schema: "public", table };
    if (filter) config.filter = filter;

    const channel = client
      .channel(channelName(`cka-${table}`))
      .on("postgres_changes", config, callback)
      .subscribe();

    return function unsubscribe() {
      return client.removeChannel(channel);
    };
  }

  const Backend = {
    client: supabaseClient,
    auth: {
      profile: currentProfile
    },

    public: {
      catalogue: () => rows("v_catalogue", {
        order: { column: "display_order", ascending: true }
      })
    },

    staff: {
      summary: () => rpc("staff_dashboard_summary"),

      quotes: {
        list: (limit) => rows("quotes", {
          order: { column: "submitted_at", ascending: false },
          limit: limit || 200
        }),
        items: (quoteId) => rows("quote_items", {
          eq: [["quote_id", quoteId]],
          order: { column: "id", ascending: true }
        }),
        update: (quoteId, changes) => rpc("staff_update_quote", {
          p_quote_id: quoteId,
          p_status: changes && changes.status != null ? changes.status : null,
          p_assigned_to: changes && changes.assignedTo != null ? changes.assignedTo : null,
          p_internal_notes: changes && changes.internalNotes != null ? changes.internalNotes : null
        }),
        subscribe: (callback) => subscribeTo("quotes", callback)
      },

      projects: {
        list: (limit) => rows("projects", {
          order: { column: "created_at", ascending: false },
          limit: limit || 200
        }),
        files: (projectId) => rows("project_files", {
          eq: [["project_id", projectId]],
          order: { column: "uploaded_at", ascending: false }
        }),
        update: (projectId, changes) => rpc("staff_update_project", {
          p_project_id: projectId,
          p_status: changes && changes.status != null ? changes.status : null,
          p_progress_pct: changes && changes.progressPct != null ? changes.progressPct : null,
          p_assigned_to: changes && changes.assignedTo != null ? changes.assignedTo : null,
          p_notes: changes && changes.notes != null ? changes.notes : null
        }),
        subscribe: (callback) => subscribeTo("projects", callback)
      },

      inquiries: {
        list: (limit) => rows("inquiries", {
          order: { column: "created_at", ascending: false },
          limit: limit || 200
        }),
        setHandled: (inquiryId, handled) => rpc("staff_set_inquiry_handled", {
          p_inquiry_id: inquiryId,
          p_handled: handled !== false
        })
      },

      supplierApplications: {
        list: (limit) => rows("supplier_applications", {
          order: { column: "submitted_at", ascending: false },
          limit: limit || 200
        }),
        review: (applicationId, decision, reviewNotes) => rpc("staff_review_supplier_application", {
          p_application_id: applicationId,
          p_decision: decision,
          p_review_notes: reviewNotes || null
        })
      },

      suppliers: {
        list: (limit) => rows("suppliers", {
          order: { column: "created_at", ascending: false },
          limit: limit || 500
        }),
        setVerification: (supplierId, verified, reliabilityPct, notes) => rpc("staff_set_supplier_verification", {
          p_supplier_id: supplierId,
          p_verified: !!verified,
          p_reliability_pct: reliabilityPct == null ? null : reliabilityPct,
          p_notes: notes || null
        }),
        linkAccount: (supplierId, profileId) => rpc("admin_link_supplier_account", {
          p_supplier_id: supplierId,
          p_profile_id: profileId
        })
      },

      bids: {
        listForQuote: (quoteId) => rows("supplier_bids", {
          eq: [["quote_id", quoteId]],
          order: { column: "placed_at", ascending: false }
        }),
        award: (bidId) => rpc("staff_award_bid", { p_bid_id: bidId }),
        subscribe: (callback) => subscribeTo("supplier_bids", callback)
      },

      newsletter: {
        list: (limit) => rows("newsletter_subscribers", {
          order: { column: "subscribed_at", ascending: false },
          limit: limit || 500
        })
      },

      audit: {
        list: (limit) => rows("admin_audit_log", {
          order: { column: "created_at", ascending: false },
          limit: limit || 200
        }),
        forEntity: (entityType, entityId, limit) => rows("admin_audit_log", {
          eq: [["entity_type", entityType], ["entity_id", entityId]],
          order: { column: "created_at", ascending: false },
          limit: limit || 100
        })
      }
    },

    supplier: {
      tenders: () => rpc("supplier_open_tenders"),
      submitBid: (quoteId, rate, deliveryDays, terms) => rpc("supplier_submit_bid", {
        p_quote_id: quoteId,
        p_rate: rate,
        p_delivery_days: deliveryDays == null ? null : deliveryDays,
        p_terms: terms || null
      }),
      bids: (limit) => rows("supplier_bids", {
        order: { column: "placed_at", ascending: false },
        limit: limit || 200
      }),
      profile: async () => {
        const list = await rows("suppliers", { limit: 2 });
        return list.length === 1 ? list[0] : (list[0] || null);
      },
      subscribeBids: (callback) => subscribeTo("supplier_bids", callback)
    },

    customer: {
      summary: () => rpc("customer_portal_summary"),
      quotes: (limit) => rows("quotes", {
        order: { column: "submitted_at", ascending: false },
        limit: limit || 200
      }),
      projects: (limit) => rows("projects", {
        order: { column: "created_at", ascending: false },
        limit: limit || 200
      }),
      subscribeQuotes: (callback) => subscribeTo("quotes", callback),
      subscribeProjects: (callback) => subscribeTo("projects", callback)
    }
  };

  global.CKABackend = Backend;
})(window);
