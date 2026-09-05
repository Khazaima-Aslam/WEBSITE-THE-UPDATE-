/* ═══════════════════════════════════════════════════════════════
   CKA BuildStruct — backend-api.js
   Stable browser facade over the production Supabase backend.

   Authorization never lives here. PostgreSQL grants, RLS and RPC
   authorization are the source of truth. No service-role worker methods are
   exposed to browser code. Requires assets/js/store.js first.
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
    return function unsubscribe() { return client.removeChannel(channel); };
  }

  const notifications = {
    list: (limit) => rows("user_notifications", {
      order: { column: "created_at", ascending: false },
      limit: limit || 100
    }),
    markRead: (notificationId) => rpc("mark_notification_read", {
      p_notification_id: notificationId
    }),
    subscribe: (callback) => subscribeTo("user_notifications", callback)
  };

  const Backend = {
    client: supabaseClient,

    auth: {
      profile: currentProfile,
      signOut: () => supabaseClient().auth.signOut()
    },

    notifications,

    public: {
      catalogue: () => rows("v_catalogue", {
        order: { column: "display_order", ascending: true }
      }),
      trackQuote: (reference, phone) => rpc("track_quote", {
        p_reference: reference,
        p_phone: phone
      }),
      trackProject: (reference, phone) => rpc("track_project", {
        p_reference: reference,
        p_phone: phone
      })
    },

    staff: {
      summary: () => rpc("staff_dashboard_summary"),
      health: () => rpc("staff_backend_health"),
      runMaintenance: () => rpc("staff_run_backend_maintenance"),

      quotes: {
        list: (limit) => rows("quotes", {
          order: { column: "submitted_at", ascending: false },
          limit: limit || 200
        }),
        items: (quoteId) => rows("quote_items", {
          eq: [["quote_id", quoteId]],
          order: { column: "id", ascending: true }
        }),
        update: (quoteId, changes) => {
          if (changes && changes.status === "bidding") {
            throw new Error("Use staff.quotes.openBidding() so the tender has a controlled deadline and validity policy.");
          }
          return rpc("staff_update_quote", {
            p_quote_id: quoteId,
            p_status: changes && changes.status != null ? changes.status : null,
            p_assigned_to: changes && changes.assignedTo != null ? changes.assignedTo : null,
            p_internal_notes: changes && changes.internalNotes != null ? changes.internalNotes : null
          });
        },
        assign: (quoteId, profileId) => rpc("staff_assign_quote", {
          p_quote_id: quoteId,
          p_assigned_to: profileId == null ? null : profileId
        }),
        openBidding: (quoteId, closesAt, allowPartialBids, minValidityDays) => rpc("staff_open_bidding", {
          p_quote_id: quoteId,
          p_closes_at: closesAt,
          p_allow_partial_bids: !!allowPartialBids,
          p_min_validity_days: minValidityDays == null ? 3 : Number(minValidityDays)
        }),
        closeBidding: (quoteId) => rpc("staff_close_bidding", { p_quote_id: quoteId }),
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
        assign: (projectId, profileId) => rpc("staff_assign_project", {
          p_project_id: projectId,
          p_assigned_to: profileId == null ? null : profileId
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
        }),
        unlinkAccount: (supplierId) => rpc("admin_unlink_supplier_account", {
          p_supplier_id: supplierId
        })
      },

      bids: {
        listForQuote: (quoteId) => rows("supplier_bids", {
          eq: [["quote_id", quoteId]],
          order: { column: "revision_no", ascending: false }
        }),
        items: (bidId) => rows("supplier_bid_items", {
          eq: [["bid_id", bidId]],
          order: { column: "id", ascending: true }
        }),
        comparison: (quoteId) => rpc("staff_bid_comparison", { p_quote_id: quoteId }),
        award: (bidId) => rpc("staff_award_bid", { p_bid_id: bidId }),
        subscribe: (callback) => subscribeTo("supplier_bids", callback),
        subscribeItems: (callback) => subscribeTo("supplier_bid_items", callback)
      },

      newsletter: {
        list: (limit) => rows("newsletter_subscribers", {
          order: { column: "subscribed_at", ascending: false },
          limit: limit || 500
        })
      },

      outbox: {
        summary: () => rpc("staff_outbox_summary"),
        list: (limit) => rows("notification_outbox", {
          order: { column: "created_at", ascending: false },
          limit: limit || 200
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
      },

      notifications
    },

    supplier: {
      tenders: () => rpc("supplier_open_tenders"),
      submitBid: (quoteId, items, options) => {
        const opts = options || {};
        return rpc("supplier_submit_bid_v2", {
          p_quote_id: quoteId,
          p_items: items,
          p_delivery_days: opts.deliveryDays == null || opts.deliveryDays === "" ? null : Number(opts.deliveryDays),
          p_terms: opts.terms || null,
          p_valid_until: opts.validUntil || null,
          p_freight_included: !!opts.freightIncluded,
          p_tax_included: !!opts.taxIncluded
        });
      },
      withdrawBid: (bidId) => rpc("supplier_withdraw_bid", { p_bid_id: bidId }),
      bids: (limit) => rows("supplier_bids", {
        order: { column: "placed_at", ascending: false },
        limit: limit || 200
      }),
      bidItems: (bidId) => rows("supplier_bid_items", {
        eq: [["bid_id", bidId]],
        order: { column: "id", ascending: true }
      }),
      profile: async () => {
        const list = await rows("suppliers", { limit: 2 });
        return list.length === 1 ? list[0] : (list[0] || null);
      },
      notifications,
      subscribeBids: (callback) => subscribeTo("supplier_bids", callback),
      subscribeBidItems: (callback) => subscribeTo("supplier_bid_items", callback)
    },

    customer: {
      summary: () => rpc("customer_portal_summary"),
      quotes: (limit) => rows("quotes", {
        order: { column: "submitted_at", ascending: false },
        limit: limit || 200
      }),
      quoteItems: (quoteId) => rows("quote_items", {
        eq: [["quote_id", quoteId]],
        order: { column: "id", ascending: true }
      }),
      projects: (limit) => rows("projects", {
        order: { column: "created_at", ascending: false },
        limit: limit || 200
      }),
      projectFiles: (projectId) => rows("project_files", {
        eq: [["project_id", projectId]],
        order: { column: "uploaded_at", ascending: false }
      }),
      claimQuote: (reference, phone) => rpc("customer_claim_quote", {
        p_reference: reference,
        p_phone: phone
      }),
      claimProject: (reference, phone) => rpc("customer_claim_project", {
        p_reference: reference,
        p_phone: phone
      }),
      notifications,
      subscribeQuotes: (callback) => subscribeTo("quotes", callback),
      subscribeProjects: (callback) => subscribeTo("projects", callback)
    }
  };

  global.CKABackend = Backend;
})(window);
